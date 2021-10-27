import type { MemberProject, Page, UserResponse } from "./deps/scrapbox.ts";

export async function getUserId() {
  const res = await fetch("https://scrapbox.io/api/users/me");
  const json = (await res.json()) as UserResponse;
  if (json.isGuest) {
    throw new Error("this script can only be executed by Logged in users");
  }
  return json.id;
}

function zero(n: string) {
  return n.padStart(8, "0");
}

export function createNewLineId(userId: string) {
  const time = Math.floor(new Date().getTime() / 1000).toString(16);
  const rand = Math.floor(0xFFFFFE * Math.random()).toString(16);
  return `${zero(time).slice(-8)}${userId.slice(-6)}0000${zero(rand)}`;
}

export async function getPageIdAndCommitId(project: string, title: string) {
  const res = await fetch(
    `https://scrapbox.io/api/pages/${project}/${
      encodeURIComponent(toTitleLc(title))
    }`,
  );
  const json = (await res.json()) as Page;
  const pageId = json.id;
  const commitId = json.commitId;
  return { pageId, commitId, persistent: json.persistent };
}

export async function getProjectId(project: string) {
  const res = await fetch(`https://scrapbox.io/api/projects/${project}`);
  const json = (await res.json()) as MemberProject;
  return json.id;
}

function toTitleLc(title: string) {
  return title.replaceAll(" ", "_").toLowerCase();
}