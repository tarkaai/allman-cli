// Global test setup
// Runs before each test file via vitest.config.ts setupFiles

import { vi } from "vitest";

// Prevent real git operations in tests
vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ files: [] }),
    checkIsRepo: vi.fn().mockResolvedValue(true),
  })),
}));
