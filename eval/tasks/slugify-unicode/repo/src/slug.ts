/** URL slug for an article title. */
export function slugify(title: string): string {
  return title.toLowerCase().replace(/ /g, "-").replace(/[^a-z0-9-]/g, "");
}
