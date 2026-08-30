/// <reference lib="webworker" />

import type { ShapeWorkerRequest, ShapeWorkerResponse } from "../../src/worker/protocol";
import { SabShapeTransport, type ShapeResultResponse } from "../../src/worker/SabShapeTransport";
import { browserShapeResult } from "./sab-shape-fixture";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let transport: SabShapeTransport | undefined;

scope.onmessage = (event: MessageEvent<ShapeWorkerRequest>): void => {
  void handle(event.data);
};

async function handle(request: ShapeWorkerRequest): Promise<void> {
  if (request.type === "attach-shape-transport") {
    transport = SabShapeTransport.attach(request.buffer);
    post({ type: "ok", requestId: request.requestId });
    return;
  }
  if (request.type === "register-font" || request.type === "unregister-font") {
    post({ type: "ok", requestId: request.requestId });
    return;
  }
  if (request.type === "dispose") {
    transport?.destroy();
    post({ type: "ok", requestId: request.requestId });
    scope.close();
    return;
  }
  if (transport === undefined) throw new Error("Shape transport is unavailable");
  const fixture = browserShapeResult();
  const result: ShapeResultResponse = {
    ...fixture,
    requestId: request.requestId,
    labelId: request.labelId,
    sourceRevision: request.sourceRevision,
    fontRevision: request.fontRevision,
    run: {
      ...fixture.run,
      text: request.input.text,
      fontFamily: request.input.family,
      fontRevision: request.fontRevision,
    },
  };
  await transport.write(result);
  post({ type: "shape-result-sab", requestId: request.requestId });
}

function post(response: ShapeWorkerResponse): void {
  scope.postMessage(response);
}
