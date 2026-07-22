import { describe,expect,it } from "vitest";
import { certificateSchema,isIsoCalendarDate,projectSchema,stageSchema } from "../src";

describe("strict domain dates",()=>{
  it.each(["2026-02-31","2026-13-01","2026-00-12","2025-02-29","0000-01-01","2026-1-01"])("rejects invalid calendar date %s",(value)=>{
    expect(isIsoCalendarDate(value)).toBe(false);
  });
  it.each(["2024-02-29","2000-02-29","1900-02-28","2026-12-31"])("accepts valid calendar date %s",(value)=>{
    expect(isIsoCalendarDate(value)).toBe(true);
  });
  it("rejects reversed project and stage ranges",()=>{
    const project={name:"P",clientId:1,discipline:"BIM",status:"ACTIVE",currency:"EGP",fxRateMicro:1_000_000,startDate:"2026-03-02",endDate:"2026-03-01",progressBp:0};
    expect(projectSchema.safeParse(project).success).toBe(false);
    expect(stageSchema.safeParse({projectId:1,name:"S",sortOrder:1,startDate:"2026-03-02",endDate:"2026-03-01",status:"PLANNED",completionBp:0}).success).toBe(false);
  });
  it("requires explicit confirmation for a due date before submission",()=>{
    const base={contractId:1,number:"C-1",date:"2026-03-01",submissionDate:"2026-03-10",dueDateOverride:"2026-03-09",grossMinor:100,discountMinor:0,status:"SUBMITTED"};
    expect(certificateSchema.safeParse(base).success).toBe(false);
    expect(certificateSchema.safeParse({...base,dueDateConfirmed:true}).success).toBe(true);
  });
});
