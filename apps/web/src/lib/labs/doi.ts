/**
 * Zenodo DOIs for archived Labs records.
 *
 * Key layout (Redis, no TTL):
 *   labs:doi:{archiveId}  STRING  JSON { doi, url }
 *
 * Written by the private publication ledger sync after a record is
 * published on Zenodo; never written from the public web app.
 */

import { labsStore } from './store';

export interface RecordDoi {
  doi: string;
  url: string;
}

const DOI_KEY = (id: string) => `labs:doi:${id}`;
const ZENODO_DOI = /^10\.5281\/zenodo\.\d+$/;

export function parseRecordDoi(raw: string | null): RecordDoi | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RecordDoi>;
    if (typeof value.doi !== 'string' || !ZENODO_DOI.test(value.doi)) return null;
    if (value.url !== `https://doi.org/${value.doi}`) return null;
    return { doi: value.doi, url: value.url };
  } catch {
    return null;
  }
}

export async function getRecordDoi(id: string): Promise<RecordDoi | null> {
  try {
    return parseRecordDoi(await labsStore().get(DOI_KEY(id)));
  } catch {
    return null;
  }
}
