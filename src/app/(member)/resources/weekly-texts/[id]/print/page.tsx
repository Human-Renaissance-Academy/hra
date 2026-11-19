import { notFound } from "next/navigation";
import { z } from "zod/v4";
import { PrintView } from "./_print-view";
import { requireSharedResourceReader } from "@/lib/resource-access";
import { getWebWeeklyTextPrintable } from "@/features/weekly-texts/web/service";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function WeeklyTextPrintPage({ params }: Props) {
  const session = await requireSharedResourceReader();

  const { id } = await params;

  // UUID 형식이 아니면 DB 조회 전에 차단한다. Postgres uuid cast 오류 메시지로 원본 ID 가 로그에 남지 않게 한다.
  const parsedId = z.uuid().safeParse(id);
  if (!parsedId.success) {
    notFound();
  }

  const text = await getWebWeeklyTextPrintable(session.user.role, parsedId.data);

  if (!text || !text.body) {
    notFound();
  }

  const fileTitle = `HRA주차별텍스트_${text.title}`;

  return (
    <PrintView
      title={text.title}
      fileTitle={fileTitle}
      createdAt={text.createdAt}
      cohortName={text.cohortName}
      textType={text.textType}
      body={text.body}
    />
  );
}
