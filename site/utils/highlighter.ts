import { createHighlighter } from "shiki";

const highlighter = createHighlighter({
  themes: ["github-light", "github-dark"],
  langs: ["bash", "typescript"],
});

export async function highlightCode(
  code: string,
  language: "bash" | "typescript",
): Promise<string> {
  const instance = await highlighter;

  return instance.codeToHtml(code, {
    lang: language,
    themes: {
      light: "github-light",
      dark: "github-dark",
    },
  });
}
