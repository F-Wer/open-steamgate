// Legal shallow counts must scale with input size in both admission readers.
import {expect} from "chai";
import {performance} from "node:perf_hooks";
import "./start.mjs";
import {readRequestXML} from "../tools/adt-request-xml.mjs";

const shapes = {
  attributes:n => '<r '+Array.from({length:n},(_,i) => `a${i}="v"`).join(' ')+'/>',
  namespaces:n => '<r '+Array.from({length:n},(_,i) => `xmlns:p${i}="urn:${i}"`).join(' ')+'>'+'<x/>'.repeat(n)+'</r>',
  // A local declaration on every sibling must not clone all inherited bindings.
  namespaceDeltas:n => '<r '+Array.from({length:n},(_,i) => `xmlns:p${i}="urn:${i}"`).join(' ')+'>'+Array.from({length:n},(_,i) => `<q:x xmlns:q="urn:local:${i}"/>`).join('')+'</r>',
};
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)];
describe("ADT XML legal-count scaling", function () {
  this.timeout(300000);
  for (const front of ["node","abap"]) for (const [shape,make] of Object.entries(shapes)) {
    it(`${front} ${shape} grows near linearly`, async () => {
      const sizes = shape === "attributes" ? [1000,2000,4000,8000,16000] : [500,1000,2000,4000,8000];
      const read = front === "node" ? body => readRequestXML(body).elements : async body => {
        const result = await abap.Classes.ZCL_OSD_ADT_REQUEST_XML.parse({iv_body:new abap.types.XString().set(body.toString("hex").toUpperCase())});
        return result.array();
      };
      for (let i=0;i<12;i++) await read(Buffer.from(make(100)));
      const times=[];
      for (const n of sizes) {
        const body=Buffer.from(make(n));
        await read(body); // warm this shape and size, outside the measured samples
        const samples=[];
        // Fast Node reads need batches to amortize GC and scheduling noise.
        // Keep every result check and the same ratios and absolute ceilings.
        for (let i=0;i<(front === "node" ? 5 : 3);i++) {
          let elapsed=0, reads=0;
          do {
            const start=performance.now(), result=await read(body);
            elapsed+=performance.now()-start;
            reads++;
            expect(result.length).to.equal(shape === "attributes" ? 1 : n+1);
            if (shape === "attributes") {
              const attrs=front === "node" ? result[0].attributes : result[0].get().attributes.array();
              expect(attrs.length).to.equal(n);
            }
          } while (front === "node" && elapsed<200 && reads<1000);
          samples.push(elapsed/reads);
        }
        times.push(median(samples));
      }
      const ratios=times.slice(1).map((t,i) => t/times[i]);
      console.log(JSON.stringify({front,shape,sizes,medianMs:times,doublingRatios:ratios}));
      // Largest two doublings avoid startup/JIT dominating tiny timings.
      for (const ratio of ratios.slice(-2)) expect(ratio,`${front} ${shape} doubling`).to.be.lessThan(3);
      // Baseline quadratic costs: ABAP attributes 36 s; Node scopes 4 s.
      const ceiling=front === "node" ? 1000 : 5000;
      expect(times.at(-1),`${front} ${shape} largest milliseconds`).to.be.lessThan(ceiling);
    });
  }
});
