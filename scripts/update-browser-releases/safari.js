/* This file is a part of @mdn/browser-compat-data
 * See LICENSE file for more information. */

import * as fs from 'node:fs';
import { styleText } from 'node:util';

import stringify from '../lib/stringify-and-order-properties.js';

import { getRSSItems, newBrowserEntry, updateBrowserEntry } from './utils.js';

const USER_AGENT =
  'MDN-Browser-Release-Update-Bot/1.0 (+https://developer.mozilla.org/)';

/**
 * @typedef {object} Release
 * @property {string} version
 * @property {string} engineVersion
 * @property {'current' | 'beta' | 'retired'} channel
 * @property {string} date
 * @property {string} releaseNote
 */

/**
 * extractReleaseData - Extract release info from string given by Apple
 * @param {string} str The string with release information
 *            E.g., Released September 18, 2023 — Version 17 (19616.1.27)
 * @returns {Release | null} Data for the release
 */
const extractReleaseData = (str) => {
  // Note: \s is needed as some spaces in Apple source are non-breaking
  const result =
    /Released\s+(.*)\s*—\s*(?:Version\s+)?(\d+(?:\.\d+)*)\s*(?:\s*beta)?\s*\((.*)\)/.exec(
      str,
    );
  if (!result) {
    console.warn(
      styleText(
        'yellow',
        `A release string for Safari is not parsable (${str}'). Skipped.`,
      ),
    );
    return null;
  }
  const isBeta = /\bbeta\b/i.test(str);
  return {
    date: new Date(`${result[1]} UTC`).toISOString().substring(0, 10),
    version: result[2].replace(/\.0$/, ''),
    channel: isBeta ? 'beta' : 'retired',
    engineVersion: result[3].substring(2),
    releaseNote: '',
  };
};

/**
 * Fetches the latest Safari Technology Preview blog post via the webkit.org RSS feed.
 * @param {string} feedURL The RSS feed URL.
 * @returns {Promise<{link: string, date: string}>} The URL and publication date of the latest post.
 */
const getLatestSTPBlogPost = async (feedURL) => {
  const items = await getRSSItems(feedURL);
  const latest = items[0];
  const date = new Date(latest.pubDate).toISOString().substring(0, 10);
  return { link: latest.link, date };
};

/**
 * Fetches a Safari TP blog post and extracts the end commit hash from the WebKit compare URL.
 * @param {string} url The blog post URL.
 * @returns {Promise<string>} The end commit hash.
 */
const extractWebKitEndCommit = async (url) => {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    throw new Error(`Failed to fetch blog post: HTTP ${response.status}`);
  }
  const html = await response.text();
  const match =
    /https:\/\/github\.com\/WebKit\/WebKit\/compare\/[0-9a-f]+\.\.\.([0-9a-f]+)/.exec(
      html,
    );
  if (!match) {
    throw new Error(`WebKit commit range not found in blog post: ${url}`);
  }
  return match[1];
};

/**
 * Fetches Configurations/Version.xcconfig for a given WebKit commit and returns the version string.
 * @param {string} commit The WebKit commit hash.
 * @returns {Promise<string>} The WebKit version (e.g., "620.1.15").
 */
const getWebKitVersionFromCommit = async (commit) => {
  const url = `https://raw.githubusercontent.com/WebKit/WebKit/${commit}/Configurations/Version.xcconfig`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Version.xcconfig: HTTP ${response.status}`,
    );
  }
  const text = await response.text();
  const major = /MAJOR_VERSION\s*=\s*(\d+)/.exec(text)?.[1];
  const minor = /MINOR_VERSION\s*=\s*(\d+)/.exec(text)?.[1];
  const tiny = /TINY_VERSION\s*=\s*(\d+)/.exec(text)?.[1];
  if (!major || !minor || !tiny) {
    throw new Error('Failed to parse WebKit version from Version.xcconfig');
  }
  return `${major}.${minor}.${tiny}`;
};

/**
 * Applies the latest Safari Technology Preview data to an already-loaded BCD object.
 * @param {*} safariBCD The in-memory BCD object to update.
 * @param {*} options The options, must include bcdBrowserName and safariTPBlogFeedURL.
 * @returns {Promise<string>} The log of what has been updated (empty if nothing or on error).
 */
const applyTPRelease = async (safariBCD, options) => {
  //
  // Get the latest Safari TP blog post via RSS
  //
  let blogPost;
  try {
    blogPost = await getLatestSTPBlogPost(options.safariTPBlogFeedURL);
  } catch (e) {
    console.error(
      styleText('red', `\nFailed to fetch Safari TP blog feed: ${e}`),
    );
    return '';
  }

  //
  // Extract the WebKit end commit from the blog post HTML
  //
  let commit;
  try {
    commit = await extractWebKitEndCommit(blogPost.link);
  } catch (e) {
    console.error(
      styleText(
        'red',
        `\nFailed to extract WebKit commit from Safari TP blog post: ${e}`,
      ),
    );
    return '';
  }

  //
  // Determine the WebKit engine version from Version.xcconfig
  //
  let engineVersion;
  try {
    engineVersion = await getWebKitVersionFromCommit(commit);
  } catch (e) {
    console.error(
      styleText(
        'red',
        `\nFailed to get WebKit version for commit ${commit}: ${e}`,
      ),
    );
    return '';
  }

  //
  // Create or update the "preview" entry
  //
  if (safariBCD.browsers[options.bcdBrowserName].releases['preview']) {
    return updateBrowserEntry(
      safariBCD,
      options.bcdBrowserName,
      'preview',
      blogPost.date,
      'nightly',
      blogPost.link,
      engineVersion,
    );
  }
  return newBrowserEntry(
    safariBCD,
    options.bcdBrowserName,
    'preview',
    'nightly',
    'WebKit',
    blogPost.date,
    blogPost.link,
    engineVersion,
  );
};

/**
 * updateSafariFile - Update the json file listing the browser version of a safari entry
 * @param {*} options The list of options for this type of Safari.
 * @returns {Promise<string>} The log of what has been generated (empty if nothing)
 */
export const updateSafariReleases = async (options) => {
  let result = '';
  //
  // Get the safari.json from the local BCD
  //
  const file = fs.readFileSync(`${options.bcdFile}`);
  const safariBCD = JSON.parse(file.toString());

  //
  // Read JSON of release notes
  //
  const releaseNoteFile = await fetch(`${options.releaseNoteJSON}`);
  if (releaseNoteFile.status !== 200) {
    console.error(
      styleText(
        'red',
        `\nRelease note file not found at Apple (${options.releaseNoteJSON}).`,
      ),
    );
    return '';
  }
  const safariRelease = JSON.parse(await releaseNoteFile.text());
  const releases = safariRelease['references'];

  //
  // Collect release data from JSON
  //
  /** @type {Release[]} */
  const releaseData = [];
  for (const id in releases) {
    // Filter out data from "Technologies" overview page
    if (releases[id].kind !== 'article') {
      continue;
    }

    const releaseDataEntry = extractReleaseData(
      releases[id].title + '\n' + releases[id].abstract[0].text,
    );

    if (!releaseDataEntry) {
      console.warn(
        styleText(
          'yellow',
          `Release string from Apple not understandable (${releases[id].abstract[0].text})`,
        ),
      );
      continue;
    } else if (/^\d+\.\d+\.\d+$/.test(releaseDataEntry.version)) {
      // Ignore patch version (e.g. "18.0.1").
      continue;
    }

    // Compute release note
    if (releases[id].url) {
      releaseDataEntry.releaseNote = `${options.releaseNoteURLBase}${releases[id].url}`;
    } else {
      releaseDataEntry.releaseNote = '';
    }
    // Don't use the date for beta, we only record release dates, not beta dates
    if (releaseDataEntry.channel === 'beta') {
      releaseDataEntry.date = '';
    }

    releaseData.push(releaseDataEntry);
  }

  //
  // Find current release
  //
  /** @type {string[]} */
  const dates = [];
  releaseData.forEach((release) => {
    if (
      release.channel !== 'beta' &&
      !options.skippedReleases.includes(release.version)
    ) {
      dates.push(release.date);
    }
  });
  const currentDate = dates.sort().pop();
  releaseData.forEach((release) => {
    if (release.date === currentDate) {
      release.channel = 'current';
    }
  });

  //
  // Update from releaseData object to BCD
  //
  releaseData.forEach((release) => {
    if (!options.skippedReleases.includes(release.version)) {
      if (
        safariBCD.browsers[options.bcdBrowserName].releases[release.version]
      ) {
        result += updateBrowserEntry(
          safariBCD,
          options.bcdBrowserName,
          release.version,
          release.date,
          release.channel,
          release.releaseNote,
          release.engineVersion,
        );
      } else {
        result += newBrowserEntry(
          safariBCD,
          options.bcdBrowserName,
          release.version,
          release.channel,
          'WebKit',
          release.date,
          release.releaseNote,
          release.engineVersion,
        );
      }
    }
  });

  //
  // Update the nightly "preview" entry from Safari Technology Preview (desktop only)
  //
  if (options.safariTPBlogFeedURL) {
    const tpResult = await applyTPRelease(safariBCD, options);
    if (tpResult) {
      result += `\n#### Technology Preview\n${tpResult}`;
    }
  }

  //
  // Write the update browser's json to file
  //
  fs.writeFileSync(`./${options.bcdFile}`, stringify(safariBCD) + '\n');

  // Returns the log
  if (result) {
    result = `### Updates for ${options.browserName}\n${result}`;
  }
  return result;
};
