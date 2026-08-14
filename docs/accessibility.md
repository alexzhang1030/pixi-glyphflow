# Accessibility

Canvas glyphs need a DOM representation for screen readers and keyboard focus. The optional
`AccessibilityAdapter` creates a sparse mirror for labels selected by product semantics.

## Setup

```ts
import { AccessibilityAdapter } from "pixi-glyphflow/accessibility";

const accessibility = new AccessibilityAdapter(layer, {
  container: document.querySelector("#scene") as HTMLElement,
  coordinateSpace: "world",
  className: "glyphflow-accessibility",
  onError: console.error,
});

accessibility.select(temperature, {
  role: "status",
  label: "Current Shanghai temperature",
  description: "Updated from the live sensor stream",
  tabIndex: 0,
  lang: "en",
});
```

## Mirror behavior

Each selected label receives one stable element. Synchronization updates rendered text, accessible
name, description, role, language, focus order, visibility, and local or world bounds. Layer commits
trigger incremental synchronization.

The overlay uses product-selected labels, which keeps DOM size proportional to interactive and
meaningful content. Large decorative label sets stay on the canvas path.

## Focus order

`tabIndex` uses native browser focus order. Select labels in the product reading order and use
standard non-negative tab indices for focusable controls. Labels with an omitted `tabIndex` remain
available to the accessibility tree as read-only content.

## Motion and zoom

World-coordinate mirrors follow the current layer global transform. A viewport frame followed by a
layer commit refreshes mirror bounds. Product controls for camera reset, zoom, and motion pause
should use native HTML controls near the canvas.

## Teardown

```ts
accessibility.destroy();
```

Destruction removes the owned overlay, mirrored elements, and layer commit listener.
