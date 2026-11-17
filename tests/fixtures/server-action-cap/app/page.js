/** 실제 Server Action 참조를 가진 native 폼입니다. 운영 앱에 포함하거나 배포하지 않습니다. */
import { inspectPayload } from "./actions";

export default function Page() {
  return (
    <main>
      <form action={inspectPayload}>
        <label htmlFor="padding">시험 본문</label>
        <textarea id="padding" name="padding" defaultValue="probe" />
        <button type="submit">전송</button>
      </form>
    </main>
  );
}
