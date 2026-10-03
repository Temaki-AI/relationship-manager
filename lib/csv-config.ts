import {
  getMaxContactImportBytes,
  getMaxContactImportMegabytes,
} from './contact-import-config.ts';

export function getMaxCsvImportMegabytes(): number {
  return getMaxContactImportMegabytes();
}

export function getMaxCsvImportBytes(): number {
  return getMaxContactImportBytes();
}
