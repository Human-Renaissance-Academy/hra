/**
 * Server Action 입력 상한(#539) 경계 테스트입니다.
 * 각 상한에 대해 "최대 허용값은 상한 검증을 통과하고, 1 초과는 한국어 안내와 함께 거부"되는지 확인합니다.
 * 인증은 모의하고 저장소·DB는 접근하면 예외를 던지게 막아, 상한 거부가 저장 전에 일어남을 보장합니다.
 * 최대 허용값은 상한 검증을 지나 저장소 접근 단계까지 가므로 예외가 던져지거나 다른 결과가 나와야 합니다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  auth: vi.fn(),
  // 서비스·DB 접근을 막는 함수입니다. 상한 검증을 통과한 요청만 여기에 닿습니다.
  blocked: () => {
    throw new Error("DB_ACCESSED");
  },
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/errors", () => ({ logServerError: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: () => mocks.blocked() }),
}));
vi.mock("@/features/notices/admin/service", () => ({
  createNotice: mocks.blocked,
  updateNotice: mocks.blocked,
}));
vi.mock("@/features/faq/admin/service", () => ({
  createItem: mocks.blocked,
  reorderItems: mocks.blocked,
}));
vi.mock("@/features/press/admin/service", () => ({
  createItem: mocks.blocked,
  updateItem: mocks.blocked,
  deleteItem: mocks.blocked,
  reorderItems: mocks.blocked,
}));
vi.mock("@/features/alumni/admin/service", () => ({
  createStory: mocks.blocked,
  updateStory: mocks.blocked,
  togglePin: mocks.blocked,
  reorderStories: mocks.blocked,
  deleteStory: mocks.blocked,
}));
vi.mock("@/features/report-templates/admin/service", () => ({
  hasDuplicateSlug: mocks.blocked,
  createAdminTemplate: mocks.blocked,
  updateAdminTemplate: mocks.blocked,
}));
vi.mock("@/features/schedule/admin/service", () => ({
  createAdminEvent: mocks.blocked,
  updateAdminEvent: mocks.blocked,
  deleteAdminEvent: mocks.blocked,
  getAdminEvent: mocks.blocked,
  listAdminEvents: mocks.blocked,
}));

import { createNotice } from "@/features/notices/actions";
import { createClassLog } from "@/features/class-logs/actions";
import { createWeeklyText } from "@/features/weekly-texts/actions";
import { createFaqItem, reorderFaqItems } from "@/features/faq/actions";
import { createReportTemplate } from "@/features/report-templates/actions";
import { createForm } from "@/features/applications/actions/forms";
import { createPressArticle, reorderPressArticles } from "@/features/press/actions";
import { createScheduleEvent } from "@/features/schedule/actions";
import { reorderGalleryImages } from "@/features/gallery/actions";
import { reorderAlumniStories } from "@/features/alumni/actions";
import { saveQuestionsSchema } from "@/features/applications/question-validation";
import { getValidatedImageFiles } from "@/lib/form-data-image-validation";
import {
  applicationQuestionLimits,
  maxFormDescriptionLength,
  maxMarkdownBodyLength,
  maxReorderIds,
  maxUrlLength,
  scheduleLimits,
  serverImageLimits,
} from "@/lib/server-action-input-limits";

/** 액션을 실행해 직렬화한 결과를 돌려줍니다. 상한 검증을 지나 DB에 닿으면 예외 문자열이 됩니다. */
async function run(action: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await action());
  } catch (error) {
    return `THROWN:${error instanceof Error ? error.message : String(error)}`;
  }
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** 최대 길이는 상한 오류가 없고 최대+1은 정확한 안내 문구가 나와야 합니다. */
async function expectBoundary(
  make: (length: number) => Promise<string>,
  limit: number,
  message: string,
) {
  expect(await make(limit)).not.toContain(message);
  expect(await make(limit + 1)).toContain(message);
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (count: number) => Array.from({ length: count }, (_, i) => uuid(i + 1));
const bodyMessage = (label: string) =>
  `${label}은 ${maxMarkdownBodyLength.toLocaleString("ko-KR")}자 이하여야 합니다.`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
  mocks.auth.mockResolvedValue(null);
});

describe("긴 본문 필드 상한", () => {
  it("공지 content", async () => {
    await expectBoundary(
      (n) =>
        run(() => createNotice(form({ title: "제목", content: "가".repeat(n), status: "DRAFT" }))),
      maxMarkdownBodyLength,
      bodyMessage("내용"),
    );
  });

  it("수업일지 content", async () => {
    await expectBoundary(
      (n) =>
        run(() =>
          createClassLog(form({ title: "제목", content: "가".repeat(n), classDate: "2026-10-14" })),
        ),
      maxMarkdownBodyLength,
      bodyMessage("내용"),
    );
  });

  it("주차별 텍스트 body", async () => {
    await expectBoundary(
      (n) => run(() => createWeeklyText(form({ title: "제목", body: "가".repeat(n) }))),
      maxMarkdownBodyLength,
      bodyMessage("본문"),
    );
  });

  it("주차별 텍스트 body는 앞뒤 공백을 제외한 길이로 판정한다", async () => {
    const message = bodyMessage("본문");
    const padded = `  ${"가".repeat(maxMarkdownBodyLength)}  `;
    expect(await run(() => createWeeklyText(form({ title: "제목", body: padded })))).not.toContain(
      message,
    );
  });

  it("FAQ answer", async () => {
    await expectBoundary(
      (n) => run(() => createFaqItem(form({ question: "질문", answer: "가".repeat(n) }))),
      maxMarkdownBodyLength,
      bodyMessage("답변"),
    );
  });

  it("보고서 양식 body", async () => {
    await expectBoundary(
      (n) =>
        run(() =>
          createReportTemplate(
            form({
              slug: "a",
              title: "제목",
              category: "guide",
              version: "1",
              body: "가".repeat(n),
              order: "0",
            }),
          ),
        ),
      maxMarkdownBodyLength,
      bodyMessage("본문"),
    );
  });

  it("지원서 양식 description", async () => {
    await expectBoundary(
      (n) => run(() => createForm(form({ title: "제목", description: "가".repeat(n) }))),
      maxFormDescriptionLength,
      `설명은 ${maxFormDescriptionLength.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  });
});

describe("언론보도 URL 상한", () => {
  const base = { title: "제목", source: "언론사", publishedAt: "2026-10-14" };
  const prefix = "https://example.com/";
  const url = (n: number) => `${prefix}${"a".repeat(n - prefix.length)}`;

  it("url", async () => {
    await expectBoundary(
      (n) => run(() => createPressArticle(form({ ...base, url: url(n) }))),
      maxUrlLength,
      `기사 링크는 ${maxUrlLength.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  });

  it("imageUrl", async () => {
    await expectBoundary(
      (n) =>
        run(() =>
          createPressArticle(form({ ...base, url: "https://example.com/a", imageUrl: url(n) })),
        ),
      maxUrlLength,
      `썸네일 URL은 ${maxUrlLength.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  });
});

describe("일정 상한", () => {
  const base = { eventDate: "2026-10-14", startTime: "09:30", eventType: "EVENT", title: "일정" };
  const schedule = (extra: Record<string, string>) =>
    run(() => createScheduleEvent({ success: false, message: "" }, form({ ...base, ...extra })));
  const session = (extra: object = {}) => ({ category: "CASE_STUDY", ...extra });

  it("description", async () => {
    await expectBoundary(
      (n) => schedule({ description: "가".repeat(n) }),
      scheduleLimits.description,
      `설명은 ${scheduleLimits.description.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  });

  it("세션 subDescription", async () => {
    await expectBoundary(
      (n) =>
        schedule({ sessionsJson: JSON.stringify([session({ subDescription: "가".repeat(n) })]) }),
      scheduleLimits.subDescription,
      `세션 설명은 ${scheduleLimits.subDescription.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  });

  it("세션 수", async () => {
    await expectBoundary(
      (n) => schedule({ sessionsJson: JSON.stringify(Array.from({ length: n }, () => session())) }),
      scheduleLimits.sessions,
      `세션은 ${scheduleLimits.sessions}개 이하여야 합니다.`,
    );
  });
});

describe("정렬 액션 배열 개수 상한", () => {
  const message = "유효하지 않은 요청입니다.";
  const cases: [string, (list: string[]) => Promise<unknown>][] = [
    ["faq", (list) => reorderFaqItems(list)],
    ["press", (list) => reorderPressArticles(list)],
    ["alumni", (list) => reorderAlumniStories(list)],
    ["gallery", (list) => reorderGalleryImages(uuid(999), list)],
  ];

  it.each(cases)("%s: 최대 개수는 통과하고 1 초과는 거부한다", async (_name, action) => {
    await expectBoundary((n) => run(() => action(ids(n))), maxReorderIds, message);
  });
});

describe("지원서 질문 저장 상한", () => {
  const formId = uuid(1);
  const parse = (questions: unknown[]) => saveQuestionsSchema.safeParse({ formId, questions });
  const firstMessage = (result: ReturnType<typeof parse>) =>
    result.success ? null : result.error.issues[0].message;
  const q = (extra: object = {}) => ({ title: "질문", type: "SHORT_ANSWER", ...extra });

  it("질문 수", () => {
    const { questions } = applicationQuestionLimits;
    expect(parse(Array.from({ length: questions }, () => q())).success).toBe(true);
    expect(firstMessage(parse(Array.from({ length: questions + 1 }, () => q())))).toBe(
      `질문은 ${questions}개 이하여야 합니다.`,
    );
  });

  it("제목·설명 길이", () => {
    const { title, description } = applicationQuestionLimits;
    expect(parse([q({ title: "가".repeat(title) })]).success).toBe(true);
    expect(firstMessage(parse([q({ title: "가".repeat(title + 1) })]))).toBe(
      `질문 제목은 ${title}자 이하여야 합니다.`,
    );
    expect(parse([q({ description: "가".repeat(description) })]).success).toBe(true);
    expect(firstMessage(parse([q({ description: "가".repeat(description + 1) })]))).toBe(
      `질문 설명은 ${description.toLocaleString("ko-KR")}자 이하여야 합니다.`,
    );
  });

  it("선택지 수", () => {
    const { options } = applicationQuestionLimits;
    const make = (n: number) =>
      q({
        type: "DROPDOWN",
        options: Array.from({ length: n }, (_, i) => ({ value: `선택${i}`, order: i })),
      });
    expect(parse([make(options)]).success).toBe(true);
    expect(firstMessage(parse([make(options + 1)]))).toBe(`선택지는 ${options}개 이하여야 합니다.`);
  });
});

describe("서버 경유 사진 개수·합계 상한", () => {
  /** 크기만 지정한 합성 파일입니다. 개수·합계 검사는 MIME 검증보다 먼저 실행됩니다. */
  const file = (size: number) => new File([new Uint8Array(size)], "a.gif", { type: "image/gif" });
  const append = (files: File[]) => {
    const data = new FormData();
    for (const f of files) data.append("images", f);
    return data;
  };

  it("개수 초과는 파일 검사 전에 거부한다", async () => {
    const result = await getValidatedImageFiles(
      append(Array.from({ length: serverImageLimits.count + 1 }, () => file(1))),
    );
    expect(result).toEqual({
      error: `사진은 한 번에 ${serverImageLimits.count}장까지 올릴 수 있습니다.`,
    });
  });

  it("개수 상한 이하는 개수 오류가 아니다", async () => {
    const result = await getValidatedImageFiles(
      append(Array.from({ length: serverImageLimits.count }, () => file(1))),
    );
    expect(JSON.stringify(result)).not.toContain("한 번에");
  });

  it("합계가 상한을 1바이트 넘으면 거부하고 상한 이하는 합계 오류가 아니다", async () => {
    const half = serverImageLimits.totalBytes / 2;
    const over = await getValidatedImageFiles(append([file(half), file(half + 1)]));
    expect(over).toEqual({ error: "사진 파일의 전체 크기는 20MB 이하여야 합니다." });
    const exact = await getValidatedImageFiles(append([file(half), file(half)]));
    expect(JSON.stringify(exact)).not.toContain("전체 크기");
  });
});
