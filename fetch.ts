import type { Page } from "./deps/scrapbox.ts";
import { toTitleLc } from "./toTitleLc.ts";

export async function getPage(project: string, title: string) {
  const res = await fetch(
    `https://scrapbox.io/api/pages/${project}/${
      encodeURIComponent(toTitleLc(title))
    }`,
  );
  if (!res.ok) throw Error(await res.text());
  return (await res.json()) as Page;
}
