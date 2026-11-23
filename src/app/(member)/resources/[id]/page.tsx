import { ClassLogDocumentForm } from "../class-logs/_components/class-log-document-form";
import { ClassLogDocumentShare } from "../class-logs/_components/class-log-document-share";
import { listClassLogDocumentHistory } from "@/features/class-logs/documents/read-service";
import { isClassLogDocumentAuthor } from "@/features/class-logs/documents/write-repository";
import { getSiteConfig } from "@/lib/site-url";
import type { Metadata } from "next";
import { formatKstDate as formatDate } from "@/lib/date-time";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, CalendarDays, Eye, User, Printer } from "lucide-react";
import { notFound } from "next/navigation";
import { z } from "zod/v4";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownViewer } from "@/components/markdown/markdown-viewer";
import { auth } from "@/lib/auth";
import { requireSharedResourceReader } from "@/lib/resource-access";
import {
  getWebClassLogDetail,
  getWebClassLogTitle,
  recordWebClassLogRead,
} from "@/features/class-logs/web/service";

export const dynamic = "force-dynamic";

type ResourceDetailPageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: ResourceDetailPageProps): Promise<Metadata> {
  const { id } = await params;

  // 검증되지 않은 UUID 를 DB 쿼리에 넘기면 Postgres cast 오류 메시지에 라우트 파라미터
  // 원문이 담겨 서버 로그에 남을 수 있다. z.uuid() 로 사전 차단하고 안전한 fallback 을 반환한다.
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) {
    return { title: "자료실" };
  }

  const session = await auth();
  const title = await getWebClassLogTitle(session?.user?.role, parsedId.data);
  return { title: title ?? "자료실" };
}

export default async function ResourceDetailPage({ params }: ResourceDetailPageProps) {
  const session = await requireSharedResourceReader();
  const { id } = await params;

  // 라우트 파라미터의 UUID 형식을 DB 조회 전에 먼저 검증해, Postgres cast 오류로
  // 원문 입력이 로그에 남지 않게 한다.
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) {
    notFound();
  }

  const data = await getWebClassLogDetail(session.user.role, parsedId.data);

  if (!data) {
    notFound();
  }

  const { log, images } = data;
  const history =
    process.env.CLASS_LOG_DOCUMENTS_ENABLED === "true"
      ? await listClassLogDocumentHistory(log.id)
      : null;
  const latest = history?.revisions[0];
  const mayRevise =
    process.env.CLASS_LOG_DOCUMENT_WRITES_ENABLED === "true" &&
    !!latest &&
    (session.user.role === "ADMIN" || (await isClassLogDocumentAuthor(log.id, session.user.id)));

  recordWebClassLogRead(session.user.role, log.id);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12 sm:py-20 md:py-32">
      <div className="mb-8">
        <Link
          href={{ pathname: "/resources", query: { category: "주차별 수업일지" } }}
          className={buttonVariants({
            variant: "ghost",
            className: "text-[#666666] hover:bg-gray-50 hover:text-[#1a1a1a]",
          })}
        >
          <ArrowLeft className="size-4" />
          목록으로
        </Link>
      </div>

      <Card className="border-[#D9D9D9] bg-white shadow-[var(--shadow-soft)] rounded-2xl py-0">
        <CardHeader className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-[#D9D9D9] py-6 sm:py-8">
          <div className="space-y-4">
            <CardTitle className="text-xl sm:text-2xl md:text-3xl font-semibold text-[#1a1a1a]">
              {log.title}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#666666] sm:gap-4 md:text-sm">
              <Badge
                variant="secondary"
                className="border border-[#D9D9D9] bg-gray-50 text-[#666666]"
              >
                <CalendarDays className="size-3.5" />
                {formatDate(log.classDate)}
              </Badge>
              <span className="inline-flex items-center gap-1.5">
                <User className="size-3.5" />
                {log.authorName ?? "삭제된 사용자"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Eye className="size-3.5" />
                조회수 {log.viewCount}
              </span>
            </div>
          </div>
          <Link
            href={`/resources/${log.id}/print`}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-[#D9D9D9] px-4 py-2 text-sm font-medium text-[#1a1a1a] transition-colors hover:border-[#2563EB] hover:text-[#2563EB]"
          >
            <Printer className="size-4" />
            PDF 저장
          </Link>
        </CardHeader>

        <CardContent className="space-y-8 py-6 sm:py-10">
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-[#1a1a1a]">내용</h2>
            <MarkdownViewer trustedSiteOrigin={getSiteConfig().url} body={log.content} />
          </section>

          {history && latest && (
            <section className="space-y-4" aria-labelledby="class-log-document-heading">
              <h2 id="class-log-document-heading" className="text-base font-semibold">
                {history.weekNumber}주차 파일
              </h2>
              <ClassLogDocumentShare />
              {history.revisions.map((revision) => (
                <details
                  key={revision.version}
                  open={revision.version === latest.version}
                  className="space-y-2"
                >
                  <summary className="cursor-pointer font-medium">
                    버전 {revision.version}
                    {revision.version === latest.version ? " · 최신본" : ""}
                    {" · "}
                    {formatDate(new Date(revision.createdAt))}
                  </summary>
                  {revision.changeNote && <p className="text-sm">{revision.changeNote}</p>}
                  <ul className="space-y-2">
                    {[revision.pdf, revision.hangul].map(
                      (file) =>
                        file && (
                          <li key={file.id} className="break-all">
                            <a
                              className="underline"
                              href={`/api/resources/class-log-documents/${file.id}/download`}
                            >
                              {file.fileName} 내려받기
                            </a>
                            {file.format === "PDF" && (
                              <a
                                className="ml-2 underline"
                                href={`/api/resources/class-log-documents/${file.id}/preview`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                PDF 열기
                              </a>
                            )}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {file.format} · {formatDate(new Date(file.uploadedAt))}
                            </span>
                          </li>
                        ),
                    )}
                  </ul>
                </details>
              ))}
              {mayRevise && (
                <details>
                  <summary className="cursor-pointer font-medium">수정본 등록</summary>
                  <ClassLogDocumentForm mode="revision" logId={log.id} version={latest.version} />
                </details>
              )}
            </section>
          )}

          {images.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-base font-semibold text-[#1a1a1a]">수업 사진</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {images.map((image) => (
                  <div
                    key={image.id}
                    className="overflow-hidden rounded-xl border border-[#D9D9D9] bg-white shadow-[var(--shadow-soft)]"
                  >
                    <Image
                      src={`/api/resources/class-log-images/${image.id}/download`}
                      unoptimized
                      alt={image.alt?.trim() || `${log.title} 이미지`}
                      width={800}
                      height={520}
                      className="h-52 w-full object-cover"
                    />
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
