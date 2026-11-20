const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const WIDE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Yi}\p{Emoji_Presentation}⺀-〾㈀-㏿︰-﹯！-｠￠-￦]/u;

// Keep the stored value identical to what BB applies: no labels, wrappers or
// markup for its line cleaner to strip, and at most 48 display columns.
export function formatTitle(text: string): string {
  const cleaned = text.replace(/[^\p{L}\p{M}\p{N} ./_+-]+/gu, " ").replace(/\s+/gu, " ").trim();
  let columns = 0;
  let end = 0;
  for (const { segment, index } of segmenter.segment(cleaned)) {
    columns += WIDE.test(segment) ? 2 : 1;
    if (columns > 48 || index + segment.length > 48) break;
    end = index + segment.length;
  }
  const bounded = cleaned.slice(0, end);
  return (end === cleaned.length ? bounded : bounded.replace(/\s+\S*$/u, "")).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
}
