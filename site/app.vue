<script setup lang="ts">
const installCode = `bun add pixi-glyphflow pixi.js pixi-viewport`;

const quickStartCode = `import { Application } from "pixi.js";
import { TextLayer } from "pixi-glyphflow";

const app = new Application();
await app.init({
  resizeTo: window,
  preference: ["webgpu", "webgl"],
  webgl: { preferWebGLVersion: 2 },
});
document.body.appendChild(app.canvas);

const labels = new TextLayer({
  renderer: app.renderer,
  initialCapacity: 100_000,
  culling: {
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    padding: 32,
  },
});
app.stage.addChild(labels);

labels.create({
  text: "Shanghai 24 C",
  x: 24,
  y: 32,
  style: { fontFamily: "Inter", fontSize: 18, fill: 0xffffff },
});

await labels.commit();`;

const viewportCode = `import { Viewport } from "pixi-viewport";
import { bindViewport } from "pixi-glyphflow/viewport";

const viewport = new Viewport({
  screenWidth: app.screen.width,
  screenHeight: app.screen.height,
  worldWidth: 18_000,
  worldHeight: 12_000,
  events: app.renderer.events,
});

viewport.drag().decelerate().wheel().pinch();
app.stage.addChild(viewport);

const binding = bindViewport(labels, viewport, { addChild: true });
await binding.whenIdle();`;

const movementCode = `const movingIds = new Float64Array(100_000);
const positions = new Float32Array(200_000);

// Fill identities from createMany() and write packed x/y pairs.
labels.updatePositions(movingIds, positions);
await labels.commit();

console.table({
  revision: labels.stats.revision,
  visible: labels.stats.visibleLabelCount,
  glyphs: labels.stats.submittedGlyphs,
});`;

const entryPoints = [
  ["pixi-glyphflow", "TextLayer, FontRegistry, and primary types"],
  ["pixi-glyphflow/viewport", "Frame-coalesced pixi-viewport binding"],
  ["pixi-glyphflow/shaping", "HarfBuzz main-thread and worker shapers"],
  ["pixi-glyphflow/accessibility", "Sparse semantic DOM mirror"],
  ["pixi-glyphflow/advanced", "Atlas, mesh, layout, upload, and spatial primitives"],
] as const;

const methods = [
  ["createMany(specs)", "Create a validated batch and return stable TextIds."],
  ["updatePositions(ids, xy)", "Apply packed position changes in one columnar pass."],
  ["updateTextPositions(ids, text, xy)", "Broadcast dynamic text with packed positions."],
  ["commit()", "Publish one monotonic revision through render and culling work."],
  ["setViewportBounds(bounds)", "Select the resident subset submitted to the renderer."],
  ["stats", "Read immutable capacity, culling, upload, draw, and timing diagnostics."],
] as const;

const guides = [
  [
    "Getting started",
    "Install, create labels, stream updates, and clean up resources.",
    "getting-started.md",
  ],
  [
    "API reference",
    "The complete stable surface, entry points, inputs, and diagnostics.",
    "api.md",
  ],
  [
    "Fonts & shaping",
    "System fonts, binary fonts, HarfBuzz, fallback, and worker output.",
    "fonts.md",
  ],
  [
    "Architecture",
    "Storage, revisions, culling, atlas residency, and renderer boundaries.",
    "architecture.md",
  ],
  [
    "Performance",
    "Fixture method, budgets, raw artifacts, and workload guidance.",
    "performance.md",
  ],
  [
    "Accessibility",
    "Sparse semantic mirrors for selected labels and focus order.",
    "accessibility.md",
  ],
] as const;
</script>

<template>
  <div class="site-frame">
    <a class="skip-link" href="#content">Skip to content</a>

    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="#top" aria-label="pixi-glyphflow home">
          <img src="/glyphflow-mark.svg" alt="" />
          <span>pixi-glyphflow</span>
          <small>v1.0.0</small>
        </a>

        <nav aria-label="Primary navigation">
          <a href="#start">Start</a>
          <a href="#viewport">Viewport</a>
          <a href="#performance">Performance</a>
          <a href="#api">API</a>
          <a
            class="github-link"
            href="https://github.com/alexzhang1030/pixi-glyphflow"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub <span aria-hidden="true">↗</span>
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>

    <main id="content">
      <section id="top" class="hero" aria-labelledby="hero-title">
        <p class="eyebrow"><span /> DENSE TEXT INFRASTRUCTURE FOR PIXIJS 8</p>
        <div class="hero-grid">
          <div>
            <h1 id="hero-title">Render text at<br />scene scale.</h1>
            <p class="hero-copy">
              One retained layer for a million labels, compact glyph batches, incremental updates,
              and camera-aware culling across WebGL and WebGPU.
            </p>
            <div class="hero-actions">
              <a class="button primary" href="#start">Build a layer</a>
              <a class="button secondary" href="#viewport">Run the viewport</a>
            </div>
          </div>

          <dl class="hero-proof" aria-label="Verified capacity">
            <div>
              <dt>Resident labels</dt>
              <dd>1,000,000</dd>
            </div>
            <div>
              <dt>Packed moves</dt>
              <dd>100k / commit</dd>
            </div>
            <div>
              <dt>Fixed CPU store</dt>
              <dd>72 MiB</dd>
            </div>
            <div>
              <dt>Renderer path</dt>
              <dd>WebGL 2 + WebGPU</dd>
            </div>
          </dl>
        </div>

        <div class="hero-demo">
          <ClientOnly>
            <GlyphflowDemo />
            <template #fallback>
              <div class="demo-fallback" aria-label="Loading interactive viewport">
                <span>Preparing the renderer…</span>
              </div>
            </template>
          </ClientOnly>
        </div>
      </section>

      <div class="content-sections">
        <section id="start" class="doc-section" aria-labelledby="start-title">
          <div class="section-intro">
            <p class="section-number">01 / START</p>
            <h2 id="start-title">Keep the public surface small.</h2>
            <p>
              Create labels synchronously, then publish accepted work through one explicit commit
              boundary. Stable identities keep hot updates compact.
            </p>
          </div>
          <div class="section-body">
            <h3>Install</h3>
            <CodeBlock :code="installCode" language="bash" label="Terminal" />
            <h3>Create one retained layer</h3>
            <CodeBlock :code="quickStartCode" />
            <p class="body-note">
              Vite builds use an ES module worker and an ES2022 target for the lazy HarfBuzz
              pipeline. This site runs that production configuration.
            </p>
          </div>
        </section>

        <section id="viewport" class="doc-section" aria-labelledby="viewport-title">
          <div class="section-intro">
            <p class="section-number">02 / VIEWPORT</p>
            <h2 id="viewport-title">Camera work stays camera work.</h2>
            <p>
              The binding converts visible viewport corners into layer-local bounds and coalesces
              drag, inertia, wheel, pinch, zoom, and rotation into one culling commit per frame.
            </p>
          </div>
          <div class="section-body">
            <h3>Bind the camera</h3>
            <CodeBlock :code="viewportCode" />
            <h3>Move 100,000 labels</h3>
            <CodeBlock :code="movementCode" />
            <div class="invariant-list" aria-label="Viewport invariants">
              <p><span>01</span> Camera frames preserve label revisions and shaped glyph runs.</p>
              <p>
                <span>02</span> Packed Float32 coordinates keep the movement path allocation-light.
              </p>
              <p>
                <span>03</span> Every binding listener leaves through one idempotent destroy path.
              </p>
            </div>
          </div>
        </section>

        <section id="performance" class="doc-section" aria-labelledby="performance-title">
          <div class="section-intro">
            <p class="section-number">03 / PERFORMANCE</p>
            <h2 id="performance-title">Measured under pressure.</h2>
            <p>
              Committed Chrome and WebGL 2 artifacts use isolated processes, GPU completion, warmup
              frames, and p95 reporting on an Apple M1 Pro.
            </p>
          </div>
          <div class="section-body">
            <div class="performance-table-wrap">
              <table class="data-table">
                <caption class="sr-only">
                  Reference performance results
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Workload</th>
                    <th scope="col">Scale</th>
                    <th scope="col">Frame p95</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td data-label="Workload">Million-label viewport</td>
                    <td data-label="Scale">1,000,000 resident</td>
                    <td data-label="Frame p95"><strong>5.20 ms</strong></td>
                  </tr>
                  <tr>
                    <td data-label="Workload">Viewport drag + inertia</td>
                    <td data-label="Scale">1,000,000 resident</td>
                    <td data-label="Frame p95"><strong>5.40 ms</strong></td>
                  </tr>
                  <tr>
                    <td data-label="Workload">Wheel + pinch zoom</td>
                    <td data-label="Scale">1,000,000 resident</td>
                    <td data-label="Frame p95"><strong>7.10 ms</strong></td>
                  </tr>
                  <tr>
                    <td data-label="Workload">Position storm</td>
                    <td data-label="Scale">100,000 packed moves</td>
                    <td data-label="Frame p95"><strong>9.00 ms</strong></td>
                  </tr>
                  <tr>
                    <td data-label="Workload">Dynamic counters</td>
                    <td data-label="Scale">100,000 text + position</td>
                    <td data-label="Frame p95"><strong>14.80 ms</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <a
              class="text-link"
              href="https://github.com/alexzhang1030/pixi-glyphflow/blob/main/benchmarks/PERFORMANCE.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the benchmark method and raw-artifact index <span aria-hidden="true">↗</span>
            </a>
          </div>
        </section>

        <section id="architecture" class="doc-section" aria-labelledby="architecture-title">
          <div class="section-intro">
            <p class="section-number">04 / ARCHITECTURE</p>
            <h2 id="architecture-title">One revision, four bounded stages.</h2>
            <p>
              Each stage owns a deep implementation boundary. The application learns one label model
              and one commit lifecycle.
            </p>
          </div>
          <div class="section-body">
            <ol class="pipeline">
              <li>
                <span>01</span>
                <div><strong>Store</strong><small>Dense identities + dirty journal</small></div>
              </li>
              <li>
                <span>02</span>
                <div><strong>Shape</strong><small>Layout + HarfBuzz worker</small></div>
              </li>
              <li>
                <span>03</span>
                <div><strong>Resident</strong><small>Atlas + glyph instances</small></div>
              </li>
              <li>
                <span>04</span>
                <div><strong>Submit</strong><small>WebGL / WebGPU adapter</small></div>
              </li>
            </ol>
          </div>
        </section>

        <section id="api" class="doc-section" aria-labelledby="api-title">
          <div class="section-intro">
            <p class="section-number">05 / API</p>
            <h2 id="api-title">Focused entry points.</h2>
            <p>
              Core usage stays on the root import. Optional integrations remain isolated so
              applications carry the surfaces they use.
            </p>
          </div>
          <div class="section-body">
            <h3>Package paths</h3>
            <dl class="api-list">
              <div v-for="entry in entryPoints" :key="entry[0]">
                <dt>
                  <code>{{ entry[0] }}</code>
                </dt>
                <dd>{{ entry[1] }}</dd>
              </div>
            </dl>
            <h3>TextLayer essentials</h3>
            <dl class="api-list">
              <div v-for="method in methods" :key="method[0]">
                <dt>
                  <code>{{ method[0] }}</code>
                </dt>
                <dd>{{ method[1] }}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section id="guides" class="doc-section guides-section" aria-labelledby="guides-title">
          <div class="section-intro">
            <p class="section-number">06 / GUIDES</p>
            <h2 id="guides-title">Follow the operating path.</h2>
            <p>
              The maintained Markdown set carries complete contracts, compatibility boundaries,
              benchmark evidence, and migration detail.
            </p>
          </div>
          <div class="section-body">
            <div class="guide-list">
              <a
                v-for="guide in guides"
                :key="guide[0]"
                :href="`https://github.com/alexzhang1030/pixi-glyphflow/blob/main/docs/${guide[2]}`"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>
                  <strong>{{ guide[0] }}</strong>
                  <small>{{ guide[1] }}</small>
                </span>
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </section>
      </div>
    </main>

    <footer class="site-footer">
      <div>
        <a class="brand footer-brand" href="#top">
          <img src="/glyphflow-mark.svg" alt="" />
          <span>pixi-glyphflow</span>
        </a>
        <p>Dense text infrastructure for PixiJS 8.</p>
      </div>
      <p>Built with Bun · TypeScript 7 · Nuxt 4 · PixiJS 8</p>
    </footer>
  </div>
</template>
