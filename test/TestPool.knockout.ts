import { TestPool, makeTokenPool, Token } from './FacadePool'
import { expect } from "chai";
import "@nomiclabs/hardhat-ethers";
import { ethers } from 'hardhat';
import { toSqrtPrice, fromSqrtPrice, maxSqrtPrice, minSqrtPrice, ZERO_ADDR } from './FixedPoint';
import { solidity } from "ethereum-waffle";
import chai from "chai";
import { MockERC20 } from '../typechain/MockERC20';
import { BigNumber } from 'ethers';

chai.use(solidity);

describe('Pool Knockout Liq', () => {
    let test: TestPool
    let baseToken: Token
    let quoteToken: Token
    const feeRate = 225 * 100

    beforeEach("deploy",  async () => {
       test = await makeTokenPool()
       baseToken = await test.base
       quoteToken = await test.quote

       await test.initPool(feeRate, 0, 1, 1.5)
       test.useHotPath = true;

       const knockoutFlag = 64 + 32 + 5 // Enabled, on grid, 32-ticks wide
       await test.testRevisePool(feeRate, 0, 1, 0, knockoutFlag)
    })

    const MINT_BUFFER = 4;

    it("mint flow", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, false)

        expect(await test.snapBaseFlow()).to.equal(5000*1024)
        expect(await test.snapQuoteFlow()).to.equal(0)
        expect(await test.liquidity()).to.equal(10000*1024) // Knockout minted off curve
    })

    it("mint flow ask", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, false, 6400-32, 6400, false)

        expect(await test.snapBaseFlow()).to.equal(0)
        expect(await test.snapQuoteFlow()).to.equal(5000*1024)
        expect(await test.liquidity()).to.equal(10000*1024) // Knockout minted off curve
    })

    it("mint off-grid", async() => {
        await test.testMintAmbient(10000)
        await expect(test.testKnockoutMint(5000*1024, true, 3201, 3201+32, false)).to.be.reverted
        await expect(test.testKnockoutMint(5000*1024, false, 6401-32, 6401, false)).to.be.reverted
    })

    it("mint bad width", async() => {
        await test.testMintAmbient(10000)
        await expect(test.testKnockoutMint(5000*1024, true, 3200, 3200+31, false)).to.be.reverted
        await expect(test.testKnockoutMint(5000*1024, true, 3200, 3200+33, false)).to.be.reverted
        await expect(test.testKnockoutMint(5000*1024, true, 3200, 3200+64, false)).to.be.reverted
        await expect(test.testKnockoutMint(5000*1024, true, 3200, 3200+16, false)).to.be.reverted
        await expect(test.testKnockoutMint(5000*1024, true, 3200, 3200-32, false)).to.be.reverted        
    })

    it("mint inside mid", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 4032, 4064, true)

        expect(await test.snapBaseFlow()).to.equal(5120000)
        expect(await test.snapQuoteFlow()).to.equal(1366505)
        expect(await test.liquidity()).to.equal((10000 + 3574914)*1024)

        await test.testKnockoutMint(5000*1024, false, 4032, 4064, true)        
        expect(await test.snapBaseFlow()).to.equal(19183551)
        expect(await test.snapQuoteFlow()).to.equal(5120000)
        expect(await test.liquidity()).to.equal((10000 + 3574914 + 13394452)*1024)
    })

    it("mint bad inside mid", async() => {
        await test.testMintAmbient(10000)
        await expect(test.testKnockoutMint(5000*1024, true, 4032, 4064, false)).to.be.reverted
        await expect(test.testKnockoutMint(5000*1024, false, 4032, 4064, false)).to.be.reverted
    })

    it("burn partial", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, false)
        await test.testKnockoutBurn(2000*1024, true, 3200, 3200+32, false)

        expect(await test.snapBaseFlow()).to.equal(-2000*1024 - 4)
        expect(await test.snapQuoteFlow()).to.equal(0)
        expect(await test.liquidity()).to.equal(10000*1024) // Knockout minted off curve
    })

    it("burn full liq", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, false)
        await test.testKnockoutBurnLiq(2660970*1024, true, 3200, 3200+32, false) // Liquidity for full position

        expect(await test.snapBaseFlow()).to.equal(-5000*1024 + 8)
        expect(await test.snapQuoteFlow()).to.equal(0)
        expect(await test.liquidity()).to.equal(10000*1024) // Knockout minted off curve
    })

    it("swap into active range", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.38)) // Inside the conc range
        expect(await test.liquidity()).to.equal(2735095009) // Liquidity comes in range

        // Goes out of range
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.5))
        expect(await test.liquidity()).to.equal(10283330) // Most drops out, but some ambient liq rewards active

        // Back in range (shouldn't knock out because didn't hit bottom point)
        await test.testSwap(false, true, 100000000, toSqrtPrice(1.38)) // Inside the conc range
        expect(await test.liquidity()).to.equal(2735138361)

        await test.testKnockoutBurnLiq(2660970*1024, true, 3200, 3200+32, true) // Liquidity for full position
        expect(await test.snapBaseFlow()).to.equal(-3378243)
        expect(await test.snapQuoteFlow()).to.equal(-1290151)
        expect(await test.liquidity()).to.equal(10288213) 
    })

    it("swap into active range ask", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, false, 6400, 6400+32, true)

        await test.testSwap(true, true, 100000000, toSqrtPrice(1.9)) // Inside the conc range
        expect(await test.liquidity()).to.equal(4420780273) // Liquidity comes in range

        // Goes out of range
        await test.testSwap(false, true, 100000000, toSqrtPrice(1.5))
        expect(await test.liquidity()).to.equal(10360857) // Most drops out, but some ambient liq rewards active

        // Back in range (shouldn't knock out because didn't hit bottom point)
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.9)) // Inside the conc range
        expect(await test.liquidity()).to.equal(4420901283)

        await test.testKnockoutBurnLiq(4410480640, false, 6400, 6400+32, true) // Liquidity for full position
        expect(await test.snapBaseFlow()).to.equal(-5794323)
        expect(await test.snapQuoteFlow()).to.equal(-2135354)
        expect(await test.liquidity()).to.equal(10373881) 
    })

    it("swap knockout", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        expect(await test.liquidity()).to.equal(10295216) // Below range

        await test.testSwap(true, true, 100000000, toSqrtPrice(1.38))
        expect(await test.liquidity()).to.equal(10296483) // Liquidity knocked out

        // Can't burn knocked out liq
        await expect(test.testKnockoutBurnLiq(1024, true, 3200, 3200+32, true)).to.be.reverted
    })

    it("swap knockout ask", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, false, 6400, 6400+32, true)

        await test.testSwap(true, true, 100000000, toSqrtPrice(1.95)) // Below knockout
        expect(await test.liquidity()).to.equal(10333689) // Below range

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.9))
        expect(await test.liquidity()).to.equal(10335206) // Liquidity knocked out

        // Can't burn knocked out liq
        await expect(test.testKnockoutBurnLiq(1024, true, 6400, 6400+32, true)).to.be.reverted
    })

    it("claim knockout", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        expect(await test.liquidity()).to.equal(10295216) // Below range

        await test.testSwap(true, true, 100000000, toSqrtPrice(1.38))
        expect(await test.liquidity()).to.equal(10296483) // Liquidity knocked out
        
        await test.testKnockoutClaim(true, 3200, 3200+32, BigNumber.from(0),  [])
        expect(await test.snapBaseFlow()).to.equal(-57670)
        expect(await test.snapQuoteFlow()).to.equal(-3753782)
        expect(await test.liquidity()).to.equal(10247391) // Slight decrease from pulling ambient rewards
    })

    it("claim knockout ask", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, false, 6400, 6400+32, true)

        await test.testSwap(true, true, 100000000, toSqrtPrice(1.95)) //Above knockout
        expect(await test.liquidity()).to.equal(10333689) // Below range

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.9))
        expect(await test.liquidity()).to.equal(10335206) // Liquidity knocked out

        await test.testKnockoutClaim(false, 6400, 6400+32, BigNumber.from(0), [])
        expect(await test.snapBaseFlow()).to.equal(-9834570)
        expect(await test.snapQuoteFlow()).to.equal(-57559) // Small payoff from ambient liquidity rewards
        expect(await test.liquidity()).to.equal(10255865) // Slight decrease from pulling ambient rewards
    })

    function formProof (pivots: number[], mileages: BigNumber[]): BigNumber[] {
        let proofs: BigNumber[] = []
        for (let i = 0; i < pivots.length; ++i) {
            proofs.push(BigNumber.from(pivots[i]).shl(64).add(BigNumber.from(mileages[i])))
        }
        return proofs
    }

    it("claim knockout proof", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.5))

        let merkleOne = (await (await test.query).queryKnockoutMerkle((await test.base).address, (await test.quote).address, test.poolIdx, true, 3200))

        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)
        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.5))

        let merkleTwo = (await (await test.query).queryKnockoutMerkle((await test.base).address, (await test.quote).address, test.poolIdx, true, 3200))

        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)
        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.5))

        await test.testKnockoutClaim(true, 3200, 3200+32, merkleOne.root, formProof([merkleOne.pivot, merkleTwo.pivot], [merkleOne.fee, merkleTwo.fee]))
        expect(await test.snapBaseFlow()).to.equal(-60294) // Small claim from rewards
        expect(await test.snapQuoteFlow()).to.equal(-3752189)
        expect(await test.liquidity()).to.equal(10374514) // Slight decrease from pulling ambient rewards
    })

    it("bad proof", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.5))

        let merkleOne = (await (await test.query).queryKnockoutMerkle((await test.base).address, (await test.quote).address, test.poolIdx, true, 3200))

        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)
        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.5))

        let merkleTwo = (await (await test.query).queryKnockoutMerkle((await test.base).address, (await test.quote).address, test.poolIdx, true, 3200))

        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)
        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.5))

        const fakeProof = formProof([merkleOne.pivot, merkleTwo.pivot], [BigNumber.from(0), merkleTwo.fee]);
        await expect(test.testKnockoutClaim(true, 3200, 3200+32, merkleOne.root, fakeProof)).to.be.reverted
    })

    it("recover knockout", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        let pivot = (await (await test.query).queryKnockoutPivot((await test.base).address, (await test.quote).address, test.poolIdx, true, 3200)).pivot

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        expect(await test.liquidity()).to.equal(10295216) // Below range

        await test.testSwap(true, true, 100000000, toSqrtPrice(1.38))
        expect(await test.liquidity()).to.equal(10296483) // Liquidity knocked out

        await test.testKnockoutRecover(true, 3200, 3200+32, pivot)
        expect(await test.snapBaseFlow()).to.equal(0) // Rewards not caimed
        expect(await test.snapQuoteFlow()).to.equal(-3711993)
        expect(await test.liquidity()).to.equal(10296483) // Slight decrease from pulling ambient rewards
    })

    it("claim knockout twice", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        let pivot = (await (await test.query).queryKnockoutPivot((await test.base).address, (await test.quote).address, test.poolIdx, true, 3200)).pivot

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.38))
        
        await test.testKnockoutClaim(true, 3200, 3200+32, BigNumber.from(0),  [])
        await test.testKnockoutClaim(true, 3200, 3200+32, BigNumber.from(0),  [])

        // No payout from a second claim
        expect(await test.snapBaseFlow()).to.equal(0)
        expect(await test.snapQuoteFlow()).to.equal(0)
        expect(await test.liquidity()).to.equal(10247391) // Slight decrease from pulling ambient rewards

        await test.testKnockoutRecover(true, 3200, 3200+32, pivot)
        expect(await test.snapBaseFlow()).to.equal(0)
        expect(await test.snapQuoteFlow()).to.equal(0)
    })

    it("recover knockout twice", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        let pivot = (await (await test.query).queryKnockoutPivot((await test.base).address, (await test.quote).address, test.poolIdx, true, 3200)).pivot

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.38))

        await test.testKnockoutRecover(true, 3200, 3200+32, pivot)
        await test.testKnockoutRecover(true, 3200, 3200+32, pivot)

        // No payout from a second claim
        expect(await test.snapBaseFlow()).to.equal(0)
        expect(await test.snapQuoteFlow()).to.equal(0)
        expect(await test.liquidity()).to.equal(10296483) // Slight decrease from pulling ambient rewards

        await test.testKnockoutClaim(true, 3200, 3200+32, BigNumber.from(0),  [])
        expect(await test.snapBaseFlow()).to.equal(0)
        expect(await test.snapQuoteFlow()).to.equal(0)
    })

    it("knockout no repeat", async() => {
        await test.testMintAmbient(10000)
        await test.testKnockoutMint(5000*1024, true, 3200, 3200+32, true)

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.38))

        await test.testSwap(false, true, 100000000, toSqrtPrice(1.35)) // Below knockout
        await test.testSwap(true, true, 100000000, toSqrtPrice(1.38))
        expect(await test.liquidity()).to.equal(10299025) // Liquidity should only knockout once

        await test.testKnockoutClaim(true, 3200, 3200+32, BigNumber.from(0),  [])
        expect(await test.snapBaseFlow()).to.equal(-57684)
        expect(await test.snapQuoteFlow()).to.equal(-3753793)
        expect(await test.liquidity()).to.equal(10249921) // Slight decrease from pulling ambient rewards
    })
})