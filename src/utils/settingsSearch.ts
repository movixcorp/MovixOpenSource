export interface SettingsSearchItem {
  id: string;
  sectionId: string;
  sectionTitle: string;
  title: string;
  description: string;
  keywords: string[];
}

const normalize = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

export function rankSettingsSearch(query: string, items: SettingsSearchItem[]): SettingsSearchItem[] {
  const needle = normalize(query);
  if (!needle) return [];

  return items
    .map((item, index) => {
      const title = normalize(item.title);
      const description = normalize(item.description);
      const keywords = normalize(item.keywords.join(' '));
      const score = title === needle
        ? 400
        : title.startsWith(needle)
          ? 300
          : title.includes(needle)
            ? 200
            : keywords.includes(needle)
              ? 120
              : description.includes(needle)
                ? 100
                : 0;

      return { item, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}
