/**
 * 자료실 양식·가이드의 본문을 JSON으로 반환하는 API입니다.
 * 공동 자료 열람 역할을 먼저 확인하고 기존 양식 우선 조회와 가이드 대체 조회를 유지합니다.
 */
import { NextResponse } from "next/server";
import { canReadSharedResource } from "@/features/resources/access";
import { auth } from "@/lib/auth";
import { resolveGuide, resolveTemplate } from "@/lib/markdown/resolve";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ message: "로그인이 필요합니다." }, { status: 401 });
  }
  // 알려진 승인 역할만 허용하며 누락되거나 새로 추가된 역할은 조회 전에 거부합니다.
  if (!canReadSharedResource(session.user.role)) {
    return NextResponse.json(
      { message: "승인 대기 중입니다. 관리자 승인 후 이용해주세요." },
      { status: 403 },
    );
  }

  const { slug } = await params;
  const template = (await resolveTemplate(slug)) ?? (await resolveGuide(slug));

  if (!template) {
    return NextResponse.json({ message: "템플릿을 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json(
    {
      body: template.body,
      title: template.title,
    },
    { status: 200 },
  );
}
