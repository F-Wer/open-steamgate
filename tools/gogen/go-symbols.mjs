// SPDX-License-Identifier: MIT
// Shared ABAP -> Go symbols, independent of the compiler and runtime.
export const typeName = (s) => {
  const name = String(s).toUpperCase().replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
  return name.startsWith("_") ? `N${name}` : name;
};
// Local static functions need an explicit class/method boundary for profiles.
export const funcName = (cls, method) => `${typeName(cls)}${cls.includes(":") ? "__OSD_METHOD__" : "_"}${typeName(method)}`;
