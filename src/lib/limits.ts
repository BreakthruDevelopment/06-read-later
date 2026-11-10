/** Caps from the read-later spec. Change them here; the checks read these constants. */
export const LIMITS = {
  savesPerHour: 60,
  savesPerDay: 300,
  linksPerUser: 2000,
  queuedPerUser: 50,
  queuedApp: 1000,
  fetchDaily: 2000,
  summaryDaily: 300,
  summariesPerHour: 30,
  retriesPerLinkPerDay: 3,
  tagsPerUser: 200,
  tagsPerPatch: 10,
  jsonBodyBytes: 8 * 1024,
} as const;
