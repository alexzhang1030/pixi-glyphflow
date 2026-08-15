<script setup lang="ts">
const minimalLabelCode = `const id = labels.create({
  text: "Hello, Glyphflow",
});

await labels.commit();`;

const groupVisibilityCode = `const stationSigns = labels.createGroup();

labels.create({ text: "Entrance", group: stationSigns });
const exit = labels.create({ text: "Exit", group: stationSigns });

labels.setGroupVisible(stationSigns, false);
await labels.commit();

labels.setGroupVisible(stationSigns, true);
labels.update(exit, { visible: false });
await labels.commit();`;

const verticalStyleCode = `labels.create({
  text: "入口",
  x: 80,
  y: 40,
  layout: { writingMode: "vertical-rl" },
  style: {
    fontSize: 24,
    fontWeight: "700",
    fill: 0x38bdf8,
  },
});

await labels.commit();`;
</script>

<template>
  <section id="examples" class="doc-section" aria-labelledby="examples-title">
    <div class="section-intro">
      <p class="section-number">02 / EXAMPLES</p>
      <h2 id="examples-title">Add the state each label needs.</h2>
      <p>
        Every label starts with text. Position, visibility, groups, layout, shaping, and style
        remain optional layers that can arrive during creation or later updates.
      </p>
    </div>
    <div class="section-body">
      <h3>Create with one required field</h3>
      <CodeBlock :code="minimalLabelCode" label="Minimal label" />
      <p class="body-note">
        Coordinates default to the origin, visibility defaults to true, and the renderer uses its
        standard text style.
      </p>

      <h3>Hide a separately created group or one TextId</h3>
      <CodeBlock :code="groupVisibilityCode" label="Visibility composition" />
      <p class="body-note">
        Group masks preserve each member's local visible flag. Every createGroup call returns a
        fresh identity owned by the layer.
      </p>

      <h3>Opt into vertical flow and appearance</h3>
      <CodeBlock :code="verticalStyleCode" label="Vertical styled label" />
      <p class="body-note">
        Vertical labels stack upright glyphs from top to bottom. Explicit lines form columns from
        right to left.
      </p>
    </div>
  </section>
</template>
