import { describe,expect,it } from "vitest";
import { parseAttachmentsResult,parseDrawings,parseMilestones,parseMilestonesResult,StructuredDataError } from "../src";

describe("structured JSON integrity",()=>{
  it("reports empty text instead of silently converting it to an empty list",()=>{
    expect(parseMilestonesResult("")).toEqual({ok:false,code:"invalid_json",raw:""});
    expect(()=>parseMilestones("")).toThrow(StructuredDataError);
  });
  it("reports malformed JSON instead of silently converting it to an empty list",()=>{
    expect(parseMilestonesResult("{broken")).toMatchObject({ok:false,code:"invalid_json",raw:"{broken"});
    expect(()=>parseMilestones("{broken")).toThrow(StructuredDataError);
    expect(()=>parseDrawings('{"not":"an array"}')).toThrow(StructuredDataError);
  });
  it("reports valid JSON with an invalid domain shape",()=>{
    expect(parseMilestonesResult('[{"title":"A","percentBp":1.5}]')).toMatchObject({ok:false,code:"invalid_shape"});
    expect(parseAttachmentsResult('["",42]')).toMatchObject({ok:false,code:"invalid_shape"});
  });
  it("preserves unknown fields for forward compatibility",()=>{
    const result=parseMilestonesResult('[{"title":"A","percentBp":10000,"futureField":{"v":2}}]');
    expect(result.ok && result.value[0]?.futureField).toEqual({v:2});
  });
});
