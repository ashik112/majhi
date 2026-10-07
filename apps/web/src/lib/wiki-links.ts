import type { AppSearch } from "@/router";

/**
 * Where a project's Deploys wiki page opens: the Wiki page with the workspace, the project and the page id in the URL
 * (`/wiki?org=<org>&project=<project>&id=deploys`). The Wiki reads the same three values when you click through, so the
 * link and the click land on the same page. Use as `<PageLink page="wiki" search={deploysPageSearch(org, project)} />`.
 */
export function deploysPageSearch(org: string, project: string): AppSearch {
  return { org, project, id: "deploys" };
}
