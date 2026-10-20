import { expect, it, vi } from "vitest";
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
  dispatch?: Parameters<typeof installWorkerPlacementReconcileGuard>[0]["dispatch"];
  destroyRequestedAtMs?: number | null;
}) {
  const resumeProvisioning = vi.fn();
  const reconcileCore = vi.fn(async () => {});
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
    dispatch: params.dispatch ?? {
      resumeProvisioning,
      hasPendingPlacementLifecycleOperation: () => false,
    },
    isStopping: () => false,
  });
  if (!guard) {
    throw new Error("worker placement reconciliation guard was not installed");
  }
  return { guard, resumeProvisioning, reconcileCore };
}

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
  const { guard, reconcileCore } = createPlacementGuard({ placement: provisioning, dispatch });
  const dispatching = dispatch.dispatch(REQUEST);
  await entered.promise;
  const initialPlacement = dispatch.waitForInitialPlacement(provisioning);
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
  await expect(initialPlacement).resolves.toEqual(active);
});

it.each([
  ["released authority", null, null, 1, true],
  ["a retained local turn claim", localClaim, null, 1, false],
  ["an active owner epoch", null, 2, 1, false],
  ["no durable destruction request", null, null, null, false],
] as const)(
  "reconciles failed-placement cleanup with %s",
  async (_reason, turnClaim, activeOwnerEpoch, destroyRequestedAtMs, allowed) => {
    const { guard, resumeProvisioning, reconcileCore } = createPlacementGuard({
      placement: {
        ...ACTIVE_PLACEMENT,
        state: "failed",
        turnClaim,
        activeOwnerEpoch,
      },
      destroyRequestedAtMs,
    });
    const reconciling = guard(ACTIVE_PLACEMENT.environmentId, reconcileCore);
    if (!allowed) {
      await expect(reconciling).rejects.toThrow("provisioning owner is failed");
      expect(reconcileCore).not.toHaveBeenCalled();
    } else {
      await reconciling;
      expect(reconcileCore).toHaveBeenCalledOnce();
    }
    expect(resumeProvisioning).not.toHaveBeenCalled();
  },
);
