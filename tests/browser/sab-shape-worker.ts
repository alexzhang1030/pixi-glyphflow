/// <reference lib="webworker" />

import { hashShapeResult } from "../../benchmarks/shaping-simd/hash";
import { SabShapeTransport } from "../../src/worker/SabShapeTransport";
import { browserShapeResult } from "./sab-shape-fixture";

interface WorkerRequest {
  readonly buffer: SharedArrayBuffer;
}

interface WorkerResponse {
  readonly structuredCloneHash: string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  void publish(event.data);
};

async function publish(request: Readonly<WorkerRequest>): Promise<void> {
  const transport = SabShapeTransport.attach(request.buffer);
  const result = browserShapeResult();
  await transport.write(result);
  const response: WorkerResponse = {
    structuredCloneHash: hashShapeResult(structuredClone(result)),
  };
  scope.postMessage(response);
}
