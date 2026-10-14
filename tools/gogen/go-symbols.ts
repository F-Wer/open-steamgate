// SPDX-License-Identifier: MIT
// Pure Go naming: no emitter, filesystem or provenance dependencies.
export const typeName = (s: string): string => {
  const name = String(s).toUpperCase().replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
  return name.startsWith("_") ? `N${name}` : name;
};
export const funcName = (cls: string, method: string): string => `${typeName(cls)}${cls.includes(":") ? "__OSD_METHOD__" : "_"}${typeName(method)}`;
