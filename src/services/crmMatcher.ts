import { investorPipelineRepo, CrmMatchResult } from '../db/repos/investorPipeline.repo.js';
import { logger } from '../logger.js';

export async function matchSender(email: string): Promise<CrmMatchResult> {
  try {
    const result = await investorPipelineRepo.matchSenderEmail(email);

    if (result.matched && result.investor_id) {
      await investorPipelineRepo.logInboundEmail(
        result.investor_id,
        `inbound email from ${email}`
      );
      logger.info(
        { investorId: result.investor_id, investorName: result.investor_name, matchedOn: result.matched_on },
        'crm match found and touchpoint logged'
      );
    }

    return result;
  } catch (error) {
    logger.error({ error, email }, 'crm matcher error');
    return {
      matched: false,
      investor_id: null,
      investor_name: null,
      matched_on: null,
    };
  }
}
