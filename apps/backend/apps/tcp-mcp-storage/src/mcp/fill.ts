/** Fills `{{name}}` placeholders in a prompt template. */
export function fill(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(vars[name]),
  );
}
