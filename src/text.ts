// Small text helpers shared by the converters. Everything here makes plain text or
// Markdown for a model to read; nothing is rendered as HTML.

// Tags out, repeated until nothing changes: one pass over "<scr<script>ipt>" leaves "<script>".
export function stripTags(s: string, to = ""): string {
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/<[^>]+>/g, to); }
  return s;
}

// <script>, <style> and <noscript> with their content out; an end tag may carry spaces or more ("</script >").
export const stripScripts = (s: string): string => s.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1[^>]*>/gi, " ");

// A pipe in a Markdown table cell, escaped. Backslashes right before it are doubled, so a cell's
// own "\|" stays a backslash and a pipe; other backslashes (LaTeX in a cell) are left alone.
export const cellPipes = (s: string): string => s.replace(/\\*\|/g, (m) => "\\".repeat(2 * m.length - 1) + "|");
