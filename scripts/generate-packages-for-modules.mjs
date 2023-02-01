import { readdirSync, writeFileSync } from "fs";

const getDirectories = (source) =>
  readdirSync(source, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

const packages = getDirectories(process.cwd() + "/../packages");

for (const p of packages) {
  console.log("Writting to package " + p);

  try {
    writeFileSync(
      process.cwd() + `/${p}/lib/cjs/package.json`,
      JSON.stringify({
        type: "commonjs",
      })
    );

    writeFileSync(
      process.cwd() + `${p}/lib/mjs/package.json`,
      JSON.stringify({
        type: "module",
      })
    );
  } catch {}
}
