import { UuidConverter } from './../src/converters';
import * as chai from 'chai';
import * as _ from "lodash";
import 'mocha';
 

const expect = chai.expect;
 

describe("Orm converters", () => {
 

    it("Should convert uuid to & from db", async () => {

        const u = "0db8f7f5-56cd-4801-ac23-ad6d78bfec3f";
        const converter = new UuidConverter();
        const uid = converter.toDB(u);

        expect(uid).to.not.be.null;
        expect(uid instanceof Buffer ).to.be.true;
        expect(uid.length).to.eq(16);

        const back = converter.fromDB(uid);
        expect(back === u.replace(/-/g,'')).to.be.true;
    })
});