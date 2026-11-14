"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_PATHS, type OpenResPaths } from "@/lib/openres/paths";

const PathsContext = createContext<OpenResPaths>(DEFAULT_PATHS);

/** Routes for every OpenRes component beneath it. Omitted keys keep their defaults. */
export function OpenResPathsProvider({
  paths,
  children,
}: {
  paths: Partial<OpenResPaths>;
  children: ReactNode;
}) {
  const { api, book, manage, staff } = paths;
  const value = useMemo(
    () => ({
      api: api ?? DEFAULT_PATHS.api,
      book: book ?? DEFAULT_PATHS.book,
      manage: manage ?? DEFAULT_PATHS.manage,
      staff: staff ?? DEFAULT_PATHS.staff,
    }),
    [api, book, manage, staff],
  );
  return <PathsContext.Provider value={value}>{children}</PathsContext.Provider>;
}

export function usePaths() {
  return useContext(PathsContext);
}
