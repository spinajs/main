import { FrameworkConfiguration } from "@spinajs/configuration";
import { join, normalize, resolve } from "path";
import { mergeArrays } from "./utils";
import * as _ from "lodash";

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        system: {
          dirs: {
            schemas: [dir("./../src/schemas")],
          },
        },
        logger: {
          targets: [
            {
              name: "Empty",
              type: "BlackHoleTarget",
            },
            {
              name: "Format",
              type: "TestTarget",
            },
            {
              name: "Variable",
              type: "TestTarget",
            },
            {
              name: "Level",
              type: "TestLevel",
            },
            {
              name: "CustomLayout",
              type: "TestTarget",
              layout: "${date:dd-MM-yyyy} ${time:HH:mm} ${message} ${custom-var}",
            },
            {
              name: "TestWildcard",
              type: "TestWildcard",
            },
            {
              name: "File",
              type: "FileTarget",
              options: {
                path: dir("./logs/log_${logger}.txt"),
                archivePath: dir("./logs/archive"),
                compress: true,
                maxArchiveFiles: 2,
                maxBufferSize: 1,
                maxSize: 100,
              },
            },
            {
              name: "file-vars",
              type: "FileTarget",
              options: {
                path: dir("./logs/log_${logger}_${date:dd_MM_yyyy}.txt"),
                archivePath: dir("./logs/archive"),
                compress: true,
                maxArchiveFiles: 2,
                maxBufferSize: 1,
                maxSize: 100 * 1000,
              },
            },
            {
                name: "big-buffer",
                type: "FileTarget",
                options: {
                  path: dir("./logs/log_${logger}.txt"),
                  archivePath: dir("./logs/archive"),
                  compress: true,
                  maxArchiveFiles: 2,
                  maxBufferSize: 1000,
                  maxSize: 100 * 100000,
                },
              },
            {
              name: "file-speed",
              type: "FileTarget",
              options: {
                path: dir("./logs/log_${logger}.txt"),
                archivePath: dir("./logs/archive"),
                compress: true,
                maxArchiveFiles: 2,
                maxBufferSize: 10,
                maxSize: 100 * 1000,
              },
            },
            {
                name: "file-archive",
                type: "FileTarget",
                options: {
                  path: dir("./logs/log_${logger}.txt"),
                  archivePath: dir("./logs/archive"),
                  compress: true,
                  maxArchiveFiles: 2,
                  maxBufferSize: 10,
                  maxSize: 1000,
                  archiveInterval: 3
                },
              },
              {
                name: "file-archive-no-compress",
                type: "FileTarget",
                options: {
                  path: dir("./logs/log_${logger}.txt"),
                  archivePath: dir("./logs/archive"),
                  compress: false,
                  maxArchiveFiles: 2,
                  maxBufferSize: 10,
                  maxSize: 1000,
                  archiveInterval: 3
                },
              },
            {
              name: "File2",
              type: "FileTarget",
              options: {
                path: dir("./logs/log_${logger}.txt"),
                archivePath: dir("./logs/archive"),
                compress: true,
                maxArchiveFiles: 2,
                maxBufferSize: 1,
              },
            },
          ],

          rules: [
            { name: "*", level: "trace", target: "Empty" },
            { name: "test-format", level: "trace", target: "Format" },
            { name: "test-variable", level: "trace", target: "Variable" },
            { name: "test-level", level: "warn", target: "Level" },
            { name: "test-layout", level: "info", target: "CustomLayout" },
            { name: "http/*/controller", level: "info", target: "TestWildcard" },
            { name: "multiple-targets", level: "info", target: ["Format", "Level"] },
            { name: "file", level: "trace", target: "File" },
            { name: "file-vars", level: "trace", target: "file-vars" },
            { name: "file2", level: "trace", target: "File2" },
            { name: "file-speed", level: "trace", target: "file-speed" },
            { name: "big-buffer", level: "trace", target: "big-buffer" },
            { name: "file-archive", level: "trace", target: "file-archive" },
            { name: "file-archive-no-compress", level: "trace", target: "file-archive-no-compress" },


          ],
        },
      },
      mergeArrays
    );
  }
}
