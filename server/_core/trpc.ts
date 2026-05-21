import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { AppError } from "../appError";
import type { TrpcContext } from "./context";
import { buildProcedureRateLimitIdentityFromRequest, consumeProcedureRateLimit } from "./rateLimiter";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const appError = error.cause instanceof AppError ? error.cause : undefined;
    return {
      ...shape,
      data: {
        ...shape.data,
        appCode: appError?.code,
        details: appError?.details,
      },
    };
  },
});

export const router = t.router;

const procedureRateLimitMiddleware = t.middleware(async (opts) => {
  if (process.env.NODE_ENV !== "test") {
    const result = consumeProcedureRateLimit(
      buildProcedureRateLimitIdentityFromRequest(opts.ctx.req, opts.path, opts.ctx.user?.id ?? null)
    );

    if (!result.allowed) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: result.message,
      });
    }
  }

  return opts.next();
});

export const publicProcedure = t.procedure.use(procedureRateLimitMiddleware);

const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
