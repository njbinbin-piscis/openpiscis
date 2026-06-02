/** Line-start `@!Piscis` / `@!piscis` delegated mention (matches backend rules). */
export function containsDelegatedPiscisMention(text: string): boolean {
  const needle = "@!piscis";
  return text.split("\n").some((line) => {
    const trimmed = line.trimStart();
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith(needle)) return false;
    const rest = trimmed.slice(needle.length);
    const ch = rest[0];
    return (
      ch === undefined
      || /\s/.test(ch)
      || [":", "：", "-", "—", ",", "，", "."].includes(ch)
    );
  });
}
