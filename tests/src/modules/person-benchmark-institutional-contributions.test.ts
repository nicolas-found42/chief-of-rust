import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BenchmarkReportSchema } from "@chief-of-staff-demo/shared";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { evaluatePerson } from "../../../apps/server/src/person-benchmark/evaluate.js";
import { renderReport } from "../../../apps/server/src/person-benchmark/report.js";
import { readPersonSource } from "../../../apps/server/src/person-profile/research-readers.js";
import type { PublicHttpResponse } from "../../../apps/server/src/source-adapters/http.js";

const RECORD_URL = "https://clinicaltrials.gov/study/NCT00949286";
const PROFILE_URL = "https://institute.example.org/people/maya-chen";

const TRIAL_RECORD = JSON.stringify({
  protocolSection: {
    identificationModule: {
      nctId: "NCT00949286",
      briefTitle: "Action in Diabetes and Vascular Disease Observational Study",
      officialTitle:
        "Action in Diabetes and Vascular Disease Preterax and Diamicron MR Controlled Evaluation Post Trial Observational Study",
      organization: { fullName: "The George Institute", class: "OTHER" },
    },
    statusModule: {
      overallStatus: "COMPLETED",
      startDateStruct: { date: "2010-01" },
      completionDateStruct: { date: "2014-02", type: "ACTUAL" },
      studyFirstPostDateStruct: { date: "2009-07-30", type: "ESTIMATED" },
      lastUpdatePostDateStruct: { date: "2014-05-19", type: "ESTIMATED" },
    },
    sponsorCollaboratorsModule: { leadSponsor: { name: "The George Institute", class: "OTHER" } },
    contactsLocationsModule: {
      overallOfficials: [
        { name: "Maya Chen", affiliation: "Atlas Institute", role: "PRINCIPAL_INVESTIGATOR" },
      ],
    },
  },
});

const answer = (
  url: string,
  status: number,
  body: string,
  contentType: string,
): PublicHttpResponse => ({
  url,
  status,
  contentType,
  body,
  etag: null,
  lastModified: null,
  retryAfter: null,
});

/**
 * A reference fact only a trial registration record carries.
 *
 * The Profile page names the person and her employer, so identity resolves and
 * the documents-publishers family retains and cites a source of its own; it
 * says nothing about the trial, so the recovered fact can only have reached
 * the dossier through the ClinicalTrials.gov record.
 */
test("a professional record recovers a reference fact no other family supplied, and the report's source accounting says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "institutional-contributions-"));
  try {
    const person = structuredClone(
      loadCorpus(
        fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
      ).people[0],
    );
    person.fictional = true;
    person.lookup = {
      fullName: "Maya Chen",
      employerHint: "Atlas Institute",
      profileUrls: [],
      emails: [],
    };
    person.facts = [
      {
        ...person.facts[0],
        id: "trial-role",
        section: "work",
        statement:
          "Maya Chen is listed as principal investigator on the ADVANCE-ON trial registration.",
        support: [{ documentId: person.documents[0].id, quote: person.documents[0].excerpt }],
      },
    ];

    const evaluation = await evaluatePerson(person, "live-discovery", {
      workspaceDir: root,
      search: async () => [
        { url: RECORD_URL, title: "ADVANCE-ON trial", snippet: "Trial registration" },
        { url: PROFILE_URL, title: "Maya Chen", snippet: "Institute profile" },
      ],
      /* The production reader, with only the transport replaced: the record is
         read and attributed by the same code the application runs. */
      readSource: async (url, snippet, ports) =>
        readPersonSource(url, snippet, {
          ...ports,
          fetch: async (target) =>
            target.includes("clinicaltrials.gov/api/v2/studies")
              ? answer(target, 200, TRIAL_RECORD, "application/json")
              : target === PROFILE_URL
                ? answer(
                    target,
                    200,
                    "Maya Chen is a research lead at the Atlas Institute.",
                    "text/plain",
                  )
                : answer(target, 404, "", "application/json"),
        }),
      complete:
        () =>
        async ({ user }) => {
          const { document } = JSON.parse(user) as { document: { url: string; text: string } };
          const quote =
            document.url === RECORD_URL
              ? (document.text.split("\n").find((line) => line.startsWith("Maya Chen")) ?? "")
              : "Maya Chen is a research lead at the Atlas Institute.";
          return {
            fullName: null,
            employer: null,
            sourceClass: document.url === RECORD_URL ? "primary-artifact" : "independent-account",
            author: null,
            publishedAt: null,
            claims: [
              {
                id: document.url === RECORD_URL ? "trial" : "role",
                section: document.url === RECORD_URL ? "work" : "career",
                statement: quote,
                status: "supported",
                nature: "statement",
                matchConfidence: "high",
                effectiveFrom: null,
                effectiveTo: null,
                citations: [{ sourceId: "source", quote }],
                supports: [],
                supersedes: [],
                changeReason: null,
              },
            ],
            works: [],
            expertise: [],
            connections: [],
            sections: [],
          };
        },
      judge: async ({ user }) => {
        const input = JSON.parse(user) as {
          references?: unknown;
          dossier: { id: string; statement: string }[];
        };
        const claim = input.dossier.find((entry) =>
          entry.statement.includes("Principal investigator"),
        );
        return input.references
          ? {
              judgements: [
                {
                  factId: "trial-role",
                  verdict: claim ? "recovered" : "missed",
                  evidence: claim?.statement ?? "",
                  claimId: claim?.id ?? null,
                  rationale: "The claim names the person as principal investigator of the trial.",
                },
              ],
            }
          : {
              understanding: 1,
              remainingQuestions: 1,
              conversationReadiness: 1,
              rationale: "One controlled fact.",
              uncertain: false,
              overclaims: [],
            };
      },
    });

    const contributions = evaluation.result.sourceContributions!;
    expect(contributions).toContainEqual(
      expect.objectContaining({
        family: "professional-records",
        recoveredFactIds: ["trial-role"],
        exclusiveRecoveredFactIds: ["trial-role"],
        sources: expect.arrayContaining([
          expect.objectContaining({ upstreamIndex: "clinicaltrials.gov", cited: true }),
        ]),
      }),
    );
    /* The other family retained and cited a source of its own, and recovered
       nothing: exclusivity here is a measured difference, not an empty run. */
    expect(contributions).toContainEqual(
      expect.objectContaining({
        family: "documents-publishers",
        recoveredFactIds: [],
        exclusiveRecoveredFactIds: [],
      }),
    );

    const report = BenchmarkReportSchema.parse(
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL(
              "../../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.json",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      ),
    );
    report.people = [evaluation.result];
    const rendered = renderReport(report, [person]);
    expect(rendered).toContain("professional-records | 2 / 1 | 1 | 1 / 1 | 1");
    expect(rendered).toContain("documents-publishers | 2 / 1 | 1 | 0 / 1 | 0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
