/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { SaxesParser } from '@rubensworks/saxes';
import { errorMessage } from './errors.js';

const maxRequests = 64;
const maxBytes = 10 * 1024 * 1024;

type ValidateUrl = (input: string, base: URL) => string;

// Only direct urlset/url/loc and sitemapindex/sitemap/loc in the root's
// namespace are listings. Extension subtrees can have their own loc elements.
function sitemapParser(url: string, onLocation: (location: string, isIndex: boolean) => void) {
  const parser = new SaxesParser({ xmlns: true, fileName: url });
  let depth = 0;
  let namespace = '';
  let isIndex = false;
  let inEntry = false;
  let hasLocation = false;
  let location: string | undefined;
  parser.on('opentag', tag => {
    depth++;
    if (depth === 1) {
      if (tag.local !== 'urlset' && tag.local !== 'sitemapindex')
        throw new Error(`Expected a urlset or sitemapindex in ${url}.`);
      namespace = tag.uri;
      isIndex = tag.local === 'sitemapindex';
    } else if (depth === 2) {
      inEntry = tag.uri === namespace && tag.local === (isIndex ? 'sitemap' : 'url');
      hasLocation = false;
    } else if (depth === 3 && inEntry && tag.uri === namespace && tag.local === 'loc') {
      location = '';
    } else if (location !== undefined || depth > 128) {
      throw new Error(`Invalid element nesting in sitemap ${url}.`);
    }
  });
  const append = (text: string) => {
    if (location !== undefined)
      location += text;
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    if (depth === 3 && location !== undefined) {
      const value = location.trim();
      if (!value || hasLocation)
        throw new Error(`Expected one nonempty loc per sitemap entry in ${url}.`);
      onLocation(value, isIndex);
      hasLocation = true;
      location = undefined;
    }
    if (depth === 2 && inEntry && !hasLocation)
      throw new Error(`Missing loc in sitemap entry in ${url}.`);
    depth--;
  });
  return parser;
}

export async function extractSitemapPages(root: string, validateUrl: ValidateUrl, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const manifests = new Set([root]);
  const fetched = new Set<string>();
  const pages: { url: string, discoveredFrom: string }[] = [];
  let bytes = 0;

  // Set iteration visits newly discovered children in insertion order (BFS).
  for (let url of manifests) {
    const chain = new Set<string>();
    try {
      while (!fetched.has(url)) {
        if (fetched.size >= maxRequests)
          throw new Error(`Sitemap expansion exceeds the ${maxRequests}-request limit.`);
        fetched.add(url);
        chain.add(url);
        const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal: fetchSignal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || chain.size > 20)
            throw new Error('Sitemap redirect is missing Location or exceeds 20 redirects.');
          url = validateUrl(location, new URL(url));
          if (chain.has(url))
            throw new Error(`Sitemap redirect loop at ${url}.`);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Failed to fetch sitemap ${url}: ${response.status} ${response.statusText}`);
        }

        const base = new URL(url);
        const parser = sitemapParser(url, (location, isIndex) => {
          if (isIndex) {
            manifests.add(validateUrl(location, base));
            if (manifests.size > maxRequests)
              throw new Error(`Sitemap expansion exceeds the ${maxRequests}-request limit.`);
          } else {
            pages.push({ url: location, discoveredFrom: url });
          }
        });
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for await (const chunk of response.body ?? []) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes)
            throw new Error('Sitemap expansion exceeds the cumulative 10 MiB limit.');
          parser.write(decoder.decode(chunk, { stream: true }));
        }
        parser.write(decoder.decode()).close();
        break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Cannot read sitemap ${url}: ${errorMessage(error)}`, { cause: error });
    }
  }
  return pages;
}
