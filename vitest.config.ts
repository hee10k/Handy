import { defineConfig } from "vitest/config";

// 단위 테스트: src 아래 *.test.ts 만 실행한다. playwright 의 `tests/**` (`.spec.ts`)
// 는 이 유닛 러너에서 제외한다. `portableInstaller.test.ts` 는 vitest 도입 이전의
// standalone 스크립트(`bun src/**/portableInstaller.test.ts`)라 유닛 러너에서
// 배제한다 (변경 최소 원칙).
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      "src/components/update-checker/portableInstaller.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});