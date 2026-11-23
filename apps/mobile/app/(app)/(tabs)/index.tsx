/**
 * 역할: 승인 회원의 홈(Home) 탭 화면
 * 사용 위치: app/(app)/(tabs)/index.tsx
 * 주요 기능:
 * - 로그인한 사용자의 인사말('안녕하세요, {name}님')과 한국어 역할 배지 표시
 * - 다가오는 일정 1건(현재 KST 월 GET /api/v1/schedule?year&month), 최근 공지(GET /api/v1/notices?page=1&pageSize=3),
 *   실제 미제출 과제(MEMBER 전용) 또는 자료실 CTA를 한 개만 노출
 * - 당겨서 새로고침 시 활성 섹션 쿼리를 일괄 재조회하며 모든 쿼리 키를 사용자 ID로 격리
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { toKoreanMessage } from '../../../src/api/errors';
import { getApiClient } from '../../../src/auth/runtime';
import { useAuth } from '../../../src/auth/use-auth';
import {
  HomeAssignmentsSection,
  HomeGreetingHeader,
  HomeNoticesSection,
  HomeResourceAction,
  HomeScheduleSection,
} from '../../../src/features/home/components';
import {
  formatHomeGreeting,
  formatRoleLabel,
  getCurrentKstYearMonth,
  homeQueryKeys,
  mapHomeNotices,
  resolveHomeAssignmentsState,
  selectHomeUpcomingSchedules,
} from '../../../src/features/home/model';
import { apiQueryOptions } from '../../../src/query/client';
import { Screen, useRefresh } from '../../../src/ui';

export default function HomeScreen() {
  const router = useRouter();
  const { user, role } = useAuth();
  const userId = user?.id ?? null;
  const effectiveRole = role ?? user?.role ?? null;
  const isAuthenticated = Boolean(userId);
  const shouldFetchAssignments = isAuthenticated && effectiveRole === 'MEMBER';

  const [now, setNow] = useState(Date.now);
  const { year, month } = getCurrentKstYearMonth(now);

  // 1) 다가오는 일정: 현재 KST 연·월 일정 조회
  const scheduleQuery = useQuery(
    {
      ...apiQueryOptions(
        homeQueryKeys.schedule(userId, year, month),
        async (signal) => {
          const { data } = await getApiClient().GET('/api/v1/schedule', {
            params: { query: { year, month } },
            signal,
          });
          return data?.events ?? [];
        },
      ),
      enabled: isAuthenticated,
    },
  );

  // 2) 최근 공지: 최신 공지 3건 조회
  const noticesQuery = useQuery(
    {
      ...apiQueryOptions(
        homeQueryKeys.notices(userId),
        async (signal) => {
          const { data } = await getApiClient().GET('/api/v1/notices', {
            params: { query: { page: 1, pageSize: 3 } },
            signal,
          });
          return data?.notices ?? [];
        },
      ),
      enabled: isAuthenticated,
    },
  );

  // 3) 내 과제: MEMBER 역할인 경우에만 최근 과제 5건 조회
  const assignmentsQuery = useQuery(
    {
      ...apiQueryOptions(
        homeQueryKeys.assignments(userId),
        async (signal) => {
          const { data } = await getApiClient().GET('/api/v1/assignments', {
            params: { query: { pageSize: 5 } },
            signal,
          });
          return data?.assignments ?? [];
        },
      ),
      enabled: shouldFetchAssignments,
    },
  );

  const { refreshing, onRefresh } = useRefresh(async () => {
    setNow(Date.now());
    if (!isAuthenticated) return;
    const tasks: Promise<unknown>[] = [
      scheduleQuery.refetch(),
      noticesQuery.refetch(),
    ];
    if (shouldFetchAssignments) {
      tasks.push(assignmentsQuery.refetch());
    }
    await Promise.allSettled(tasks);
  });

  const greeting = formatHomeGreeting(user?.name);
  const roleLabel = formatRoleLabel(effectiveRole);

  const scheduleItems = scheduleQuery.data
    ? selectHomeUpcomingSchedules(scheduleQuery.data, now, 1)
    : [];
  const scheduleError = scheduleQuery.isError
    ? toKoreanMessage(scheduleQuery.error)
    : null;

  const noticeItems = noticesQuery.data ? mapHomeNotices(noticesQuery.data) : [];
  const noticesError = noticesQuery.isError
    ? toKoreanMessage(noticesQuery.error)
    : null;

  const assignmentsResolution = resolveHomeAssignmentsState({
    role: effectiveRole,
    assignments: assignmentsQuery.data,
    error: assignmentsQuery.isError ? assignmentsQuery.error : undefined,
    now,
  });

  // 비활성·0건·다른 역할은 실행 가능한 자료실 바로가기 한 개로 대체합니다.
  const showAssignmentSection =
    shouldFetchAssignments &&
    (assignmentsQuery.isPending ||
      assignmentsResolution.kind === 'error' ||
      (assignmentsResolution.kind === 'ready' && assignmentsResolution.summary.pendingCount > 0));

  return (
    <Screen
      scroll
      padding="md"
      refreshing={refreshing}
      onRefresh={() => void onRefresh()}
      testID="home-screen"
    >
      <HomeGreetingHeader greeting={greeting} roleLabel={roleLabel} />

      <HomeScheduleSection
        isPending={isAuthenticated && scheduleQuery.isPending}
        errorMessage={scheduleError}
        items={scheduleItems}
        onRetry={() => void scheduleQuery.refetch()}
        onPressViewAll={() => router.push('/(app)/(tabs)/schedule')}
      />

      {showAssignmentSection ? (
        <HomeAssignmentsSection
          isPending={assignmentsQuery.isPending}
          resolution={assignmentsResolution}
          onRetry={() => void assignmentsQuery.refetch()}
          onPressAssignments={() => router.push('/assignments')}
        />
      ) : (
        <HomeResourceAction
          role={effectiveRole}
          onPress={() => router.push('/(app)/(tabs)/resources')}
        />
      )}

      <HomeNoticesSection
        isPending={isAuthenticated && noticesQuery.isPending}
        errorMessage={noticesError}
        items={noticeItems}
        onRetry={() => void noticesQuery.refetch()}
        onPressViewAll={() => router.push('/(app)/(tabs)/notices')}
        onPressNotice={(noticeId) => router.push(`/notices/${noticeId}`)}
      />
    </Screen>
  );
}
