import { Agenda } from 'agenda';
import * as lilitStandup from './heartbeat.lilitStandup.js';
import * as nightlyBackup from './system.nightlyBackup.js';
import * as costRollup from './system.costRollup.js';

export function defineAllJobs(agenda: Agenda): void {
  lilitStandup.defineJob(agenda);
  nightlyBackup.defineJob(agenda);
  costRollup.defineJob(agenda);
}

export async function scheduleAllJobs(agenda: Agenda): Promise<void> {
  await lilitStandup.scheduleJob(agenda);
  await nightlyBackup.scheduleJob(agenda);
  await costRollup.scheduleJob(agenda);
}

export { lilitStandup, nightlyBackup, costRollup };
