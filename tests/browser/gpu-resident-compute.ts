import {
  runGpuResidentComputeSpike,
  type GpuResidentComputeSpikeResult,
} from "../../benchmarks/gpu-resident-compute";

interface GpuResidentComputeFixtureState {
  readonly done: boolean;
  readonly result?: GpuResidentComputeSpikeResult;
  readonly error?: string;
}

declare global {
  interface Window {
    __gpuResidentComputeFixture: GpuResidentComputeFixtureState;
  }
}

window.__gpuResidentComputeFixture = { done: false };

void runGpuResidentComputeSpike().then(
  (result) => {
    window.__gpuResidentComputeFixture = { done: true, result };
  },
  (error: unknown) => {
    window.__gpuResidentComputeFixture = {
      done: true,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    };
  },
);
