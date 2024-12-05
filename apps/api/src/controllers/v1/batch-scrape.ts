import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  BatchScrapeRequest,
  batchScrapeRequestSchema,
  CrawlResponse,
  RequestWithAuth,
} from "./types";
import {
  addCrawlJobs,
  getCrawl,
  lockURLs,
  saveCrawl,
  StoredCrawl,
} from "../../lib/crawl-redis";
import { logCrawl } from "../../services/logging/crawl_log";
import { getScrapeQueue } from "../../services/queue-service";
import { getJobPriority } from "../../lib/job-priority";
import { addScrapeJobs } from "../../services/queue-jobs";
import { callWebhook } from "../../services/webhook";

export async function batchScrapeController(
  req: RequestWithAuth<{}, CrawlResponse, BatchScrapeRequest>,
  res: Response<CrawlResponse>
) {
  req.body = batchScrapeRequestSchema.parse(req.body);

  const id = req.body.appendToId ?? uuidv4();

  if (!req.body.appendToId) {
    await logCrawl(id, req.auth.team_id);
  }

  let { remainingCredits } = req.account!;
  const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === 'true';
  if(!useDbAuthentication){
    remainingCredits = Infinity;
  }

  const sc: StoredCrawl = req.body.appendToId ? await getCrawl(req.body.appendToId) as StoredCrawl : {
    crawlerOptions: null,
    scrapeOptions: req.body,
    internalOptions: {},
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    plan: req.auth.plan,
  };

  if (!req.body.appendToId) {
    await saveCrawl(id, sc);
  }

  let jobPriority = 20;

  // If it is over 1000, we need to get the job priority,
  // otherwise we can use the default priority of 20
  if(req.body.urls.length > 1000){
    // set base to 21
    jobPriority = await getJobPriority({plan: req.auth.plan, team_id: req.auth.team_id, basePriority: 21})
  }

  const scrapeOptions: ScrapeOptions = { ...req.body };
  delete (scrapeOptions as any).urls;
  delete (scrapeOptions as any).appendToId;

  const jobs = req.body.urls.map((x) => {
    return {
      data: {
        url: x,
        mode: "single_urls" as const,
        team_id: req.auth.team_id,
        plan: req.auth.plan!,
        crawlerOptions: null,
        scrapeOptions,
        origin: "api",
        crawl_id: id,
        sitemapped: true,
        v1: true,
        webhook: req.body.webhook,
      },
      opts: {
        jobId: uuidv4(),
        priority: 20,
      },
    };
  });

  await lockURLs(
    id,
    sc,
    jobs.map((x) => x.data.url)
  );
  await addCrawlJobs(
    id,
    jobs.map((x) => x.opts.jobId)
  );
  await addScrapeJobs(jobs);

  if(req.body.webhook) {
    await callWebhook(req.auth.team_id, id, null, req.body.webhook, true, "batch_scrape.started");
  }

  const protocol = process.env.ENV === "local" ? req.protocol : "https";
  
  return res.status(200).json({
    success: true,
    id,
    url: `${protocol}://${req.get("host")}/v1/batch/scrape/${id}`,
  });
}


