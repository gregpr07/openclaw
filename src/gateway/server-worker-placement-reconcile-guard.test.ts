import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  PROVISIONING_PLACEMENT,
  REQUEST,
  createCoordinatorTestService,
} from "./worker-environments/placement-dispatch-coordinator.test-support.js";
import type { WorkerDispatchPlacement } from "./worker-environments/placement-dispatch-failure.js";

const localClaim = {
  owner: "local" as const,
  claimId: "claim-cleanup",
  runId: "run-cleanup",
  generation: 1,
  ownerEpoch: null,
};

function createPlacementGuard(params: {
  placement: WorkerDispatchPlacement;
  dispatch: Parameters<typeof installWorkerPlacementReconcileGuard>[0]["dispatch"];
  destroyRequestedAtMs?: number | null;
}) {
  let guard:
    | ((environmentId: string, reconcileCore: () => Promise<void>) => Promise<void>)
    | undefined;
  installWorkerPlacementReconcileGuard({
    placements: {
      readEnvironmentOwner: async () => params.placement,
    } as never,
    environments: {
      get: (environmentId: string) => ({
        environmentId,
        state: "provisioning",
        destroyRequestedAtMs: params.destroyRequestedAtMs,
      }),
      installReconcileEnvironmentGuard: (installed: typeof guard) => {
        guard = installed;
        return async () => {};
      },
    } as never,
    dispatch: params.dispatch,
    isStopping: () => false,
  });
  if (!guard) {
    throw new Error("worker placement reconciliation guard was not installed");
  }
  return guard;
}

function createFailedPlacementGuard(
  turnClaim: typeof localClaim | null = null,
  activeOwnerEpoch: number | null = null,
  destroyRequestedAtMs: number | null = 1,
) {
  const resumeProvisioning = vi.fn();
  const guard = createPlacementGuard({
    placement: {
      ...ACTIVE_PLACEMENT,
      sessionId: "session-cleanup",
      state: "failed",
      environmentId: "worker-cleanup",
      recoveryError: "Provider teardown required",
      turnClaim,
      activeOwnerEpoch,
    },
    destroyRequestedAtMs,
    dispatch: { resumeProvisioning, hasPendingPlacementLifecycleOperation: () => false },
  });
  return { guard, resumeProvisioning };
}

describe("worker placement reconciliation teardown authority", () => {
  it("preserves a live dispatch's initial-placement waiter during environment reconciliation", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const provisioning = { ...PROVISIONING_PLACEMENT, sessionId: REQUEST.sessionId };
    const active = { ...ACTIVE_PLACEMENT, environmentId: provisioning.environmentId };
    const resumeProvisioning = vi.fn(async () => undefined);
    const dispatch = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (_request, onTransition) => {
          onTransition?.(provisioning);
          entered.resolve();
          await release.promise;
          return active;
        },
        resumeProvisioning,
      }),
      (_request, run) => run(),
    );
    const guard = createPlacementGuard({ placement: provisioning, dispatch });
    const reconcileCore = vi.fn(async () => {});
    const dispatching = dispatch.dispatch(REQUEST);
    await entered.promise;
    const initialPlacement = dispatch.waitForInitialPlacement(provisioning).then(
      (placement) => ({ placement }),
      (error: unknown) => ({ error }),
    );
    const reconciling = guard(provisioning.environmentId, reconcileCore);
    try {
      await expect(
        Promise.race([
          reconciling.then(() => "reconciled"),
          initialPlacement.then(() => "initial placement settled"),
        ]),
      ).resolves.toBe("reconciled");
      expect([resumeProvisioning.mock.calls, reconcileCore.mock.calls]).toEqual([[], []]);
    } finally {
      release.resolve();
      await Promise.all([dispatching, reconciling]);
    }
    await expect(initialPlacement).resolves.toEqual({ placement: active });
  });

  it("allows destruction only after its exact failed owner has released all authority", async () => {
    const { guard, resumeProvisioning } = createFailedPlacementGuard();
    const reconcileCore = vi.fn(async () => {});

    await guard("worker-cleanup", reconcileCore);

    expect(reconcileCore).toHaveBeenCalledOnce();
    expect(resumeProvisioning).not.toHaveBeenCalled();
  });

  it.each([
    ["a retained local turn claim", localClaim, null, 1],
    ["an active owner epoch", null, 2, 1],
    ["no durable destruction request", null, null, null],
  ] as const)(
    "keeps failed-placement cleanup fenced with %s",
    async (_reason, turnClaim, activeOwnerEpoch, destroyRequestedAtMs) => {
      const { guard, resumeProvisioning } = createFailedPlacementGuard(
        turnClaim,
        activeOwnerEpoch,
        destroyRequestedAtMs,
      );
      const reconcileCore = vi.fn(async () => {});

      await expect(guard("worker-cleanup", reconcileCore)).rejects.toThrow(
        "provisioning owner is failed",
      );

      expect([reconcileCore.mock.calls, resumeProvisioning.mock.calls]).toEqual([[], []]);
    },
  );
});
