import type { Range, RangeOptions } from '@umijs/utils/compiled/semver';
import { createHash } from 'crypto';
import Cache from 'file-system-cache';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { lodash, logger, semver, winPath } from 'umi/plugin-utils';
import { promisify } from 'util';
import type {
  RunLoaderOption as InternalRunLoaderOption,
  RunLoaderResult,
} from '../compiled/loader-runner';
import { runLoaders as callbackRunLoaders } from '../compiled/loader-runner';
import { FS_CACHE_DIR } from './constants';
export type * from '../compiled/loader-runner';
export { getContext } from '../compiled/loader-runner';
/**
 * get route path from file-system path
 */
export function getFileIdFromFsPath(fsPath: string) {
  return lodash.kebabCase(winPath(fsPath).replace(/((\/|^)index)?\.\w+$/g, ''));
}

/**
 * get range lines of markdown file
 */
export const getFileRangeLines = (content: string, range: string) => {
  const [, start, end] = range?.match(/^L(\d+)(?:-L(\d+))?$/) || [];

  if (start) {
    const lineStart = parseInt(start, 10) - 1;
    const lineEnd = end ? parseInt(end, 10) : lineStart + 1;

    return content
      .split(/\r\n|\n/g)
      .slice(lineStart, lineEnd)
      .join('\n');
  }

  return content;
};

/**
 * get file content by regular expression
 * @param content   source file content
 * @param regexp    regular expression string
 * @param filePath  source file path
 */
export const getFileContentByRegExp = (
  content: string,
  regexp: string,
  filePath: string,
) => {
  try {
    // eslint-disable-next-line no-eval
    return content.match(eval(regexp))![0];
  } catch (err) {
    logger.error(`Extract markdown content failed, use the full content.
RegExp: ${regexp}
File: ${filePath}
Error: ${err}`);
    return content;
  }
};

/**
 * parse frontmatter from code string,
 * also supports html/xml comments
 */
export function parseCodeFrontmatter(raw: string) {
  const [, comment = '', code = ''] = raw
    // clear head break lines
    .replace(/^\n\s*/, '')
    // split head comments & remaining code
    .match(/^(\/\*\*[^]*?\n\s*\*\/|<!--[^]*?\n\s*-->)?(?:\s|\n)*([^]+)?$/)!;

  const yamlComment = comment
    // clear / from head & foot for comment
    .replace(/^(\/|<!--)|(\/|-->)$/g, '')
    // remove * from comments
    .replace(/(^|\n)\s*\*+/g, '$1');
  let frontmatter: Record<string, any> | null = null;

  try {
    frontmatter = yaml.load(yamlComment) as any;
  } catch {}

  return { code: frontmatter ? code : raw, frontmatter };
}

/**
 * get file-system cache for specific namespace
 */
let cacheDir = FS_CACHE_DIR;
const caches: Record<string, ReturnType<typeof Cache>> = {};
export function _setFSCacheDir(dir: string) {
  cacheDir = dir;
}
export function getCache(ns: string): (typeof caches)['0'] {
  // return fake cache if cache disabled
  if (process.env.DUMI_CACHE === 'none') {
    return { set() {}, get() {}, setSync() {}, getSync() {} } as any;
  }
  return (caches[ns] ??= Cache({ basePath: path.resolve(cacheDir, ns) }));
}

/**
 * try to get father config
 */
export async function tryFatherBuildConfigs(cwd: string) {
  let configs: any[] = [];
  const APP_ROOT = process.env.APP_ROOT;

  process.env.APP_ROOT = cwd;

  try {
    // use father service to resolve config
    const { Service: FatherSvc } = await import(
      'father/dist/service/service.js'
    );
    const { normalizeUserConfig: getBuildConfig } = await import(
      'father/dist/builder/config.js'
    );
    const svc = new FatherSvc();

    svc.commands.empty = {
      name: 'empty',
      fn() {},
      configResolveMode: 'loose',
      plugin: { id: 'empty' } as any,
    };
    await svc.run({ name: 'empty' });
    configs = getBuildConfig(svc.config, svc.pkg);
  } catch {
    /* nothing */
  }

  // why check first? because assign undefined to env will be converted to string
  if (APP_ROOT) process.env.APP_ROOT = APP_ROOT;

  return configs;
}

/**
 * get root dir for monorepo project
 */
export function getProjectRoot(cwd: string) {
  const splittedCwd = winPath(cwd).split('/');

  // try to find root cwd for monorepo project, only support >= 3 level depth
  for (let level = -1; level >= -3; level -= 1) {
    const rootCwd = splittedCwd.slice(0, level).join('/');

    // break if no parent dir
    if (!rootCwd) break;

    // check monorepo for parent dir
    const pkgPath = path.join(rootCwd, 'package.json');

    if (
      fs.existsSync(pkgPath) &&
      (['pnpm-workspace.yaml', 'lerna.json'].some((f) =>
        fs.existsSync(path.join(rootCwd, f)),
      ) ||
        require(pkgPath).workspace)
    ) {
      return winPath(rootCwd);
    }
  }

  return winPath(cwd);
}

function lastSlash(str: string) {
  return str[str.length - 1] === '/' ? str : `${str}/`;
}

/**
 *
 * transform component into webpack chunkName
 * @export
 * @param {string} component component path
 * @param {string} [cwdPath] current root path
 * @return {*}  {string}
 */
export function componentToChunkName(
  component: string,
  cwdPath: string = '/',
): string {
  const cwd = winPath(cwdPath);

  return typeof component === 'string'
    ? winPath(component)
        .replace(
          new RegExp(
            `^(${
              // match app cwd first
              lodash.escapeRegExp(lastSlash(cwd))
            })`,
          ),
          '',
        )
        .replace(/^.(\/|\\)/, '')
        .replace(/(\/|\\)/g, '__')
        .replace(/^src__/, '')
        .replace(/\.\.__/g, '')
        .replace(/^pages__/, 'p__')
    : '';
}

export function generateMetaChunkName(
  path: string,
  cwd: string,
  locales: string[] = [],
): string {
  const chunkName = componentToChunkName(path, cwd);

  const dir = chunkName.replace(/^(.*?)_.*/, '$1');

  const localeRegExp = new RegExp(`.*(${locales.join('|')}).*`);
  const ifLocale = locales.length && localeRegExp.test(chunkName);
  const locale = ifLocale ? `__${chunkName.replace(localeRegExp, '$1')}` : '';

  return `meta__${dir}${locale}`;
}

/**
 * generate hash for string
 */
export function getContentHash(content: string, length = 8) {
  return createHash('md5').update(content).digest('hex').slice(0, length);
}

const promisifyRunLoaders = promisify(callbackRunLoaders);

export type RunLoaderOption = Partial<InternalRunLoaderOption>;

export function runLoaders(options: RunLoaderOption): Promise<RunLoaderResult>;
export function runLoaders(
  options: RunLoaderOption,
  callback: undefined,
): Promise<RunLoaderResult>;
export function runLoaders(
  options: RunLoaderOption,
  callback: (err: NodeJS.ErrnoException | null, result: RunLoaderResult) => any,
): void;
export function runLoaders(
  options: RunLoaderOption,
  callback?: (
    err: NodeJS.ErrnoException | null,
    result: RunLoaderResult,
  ) => any,
) {
  if (callback !== undefined) {
    return callbackRunLoaders(options as InternalRunLoaderOption, callback);
  }
  return promisifyRunLoaders(options as InternalRunLoaderOption);
}
/**
 * check if version is in range
 */
export function isVersionInRange(
  version: string,
  range: string | Range,
  options: RangeOptions = { includePrerelease: true },
) {
  if (semver.valid(version)) {
    return semver.satisfies(version, range, options);
  }
  if (semver.validRange(version)) {
    return semver.subset(version, range, options);
  }
  return false;
}
