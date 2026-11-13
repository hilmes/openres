/**
 * Where the guest pages, staff desk and API live. A standalone installation uses
 * the defaults. A host site that mounts the components under its own routes, or
 * runs a second API base beside the live one, supplies its own through
 * `OpenResPathsProvider`. Plain module: safe to import from server components.
 */
export type OpenResPaths = {
  /** API base without a trailing slash. */
  api: string;
  /** Guest booking page. */
  book: string;
  /** Guest management page; the private token is appended as a URL fragment. */
  manage: string;
  /** Staff desk. */
  staff: string;
};

export const DEFAULT_PATHS: OpenResPaths = {
  api: "/api/openres",
  book: "/book",
  manage: "/manage",
  staff: "/staff",
};
