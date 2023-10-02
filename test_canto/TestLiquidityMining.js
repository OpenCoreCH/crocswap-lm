const { expect } = require("chai");
const exp = require("constants");
const { BigNumber } = require("ethers");
var AbiCoder = require("@ethersproject/abi").AbiCoder;
const { solidity } = require("ethereum-waffle");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
var keccak256 = require("@ethersproject/keccak256").keccak256;

const chai = require("chai");
const abi = new AbiCoder();

const BOOT_PROXY_IDX = 0;
const SWAP_PROXY_IDX = 1;
const LP_PROXY_IDX = 2;
const COLD_PROXY_IDX = 3;
const LONG_PROXY_IDX = 4;
const MICRO_PROXY_IDX = 5;
const KNOCKOUT_LP_PROXY_IDX = 7;
const LIQUIDITY_MINING_PROXY_IDX = 8;
const FLAG_CROSS_PROXY_IDX = 3500;
const SAFE_MODE_PROXY_PATH = 9999;

const PRECISION = 100000000;
const Q_64 = BigNumber.from(2).pow(64);

function toSqrtPrice(price) {
	let sqrtFixed = Math.round(Math.sqrt(price) * PRECISION);
	return BigNumber.from(sqrtFixed).mul(Q_64).div(PRECISION);
}

chai.use(solidity);

describe("Liquidity Mining Tests", function () {
	it("deploy contracts and init pool", async function () {
		const [owner] = await ethers.getSigners();

		////////////////////////////////////////////////
		// DEPLOY AND MINT cNOTE and USDC
		////////////////////////////////////////////////
		const cNOTE = await ethers.deployContract("MockERC20");
		const USDC = await ethers.deployContract("MockERC20");
		const setX = await cNOTE.setDecimals(18);
		const setY = await USDC.setDecimals(6);
		const depositX = await cNOTE.deposit(
			owner.address,
			ethers.utils.parseEther("1000000")
		);
		const depositY = await USDC.deposit(
			owner.address,
			ethers.utils.parseUnits("1000000", 6)
		);

		////////////////////////////////////////////////
		// deploy CrocSwapDex contract
		////////////////////////////////////////////////
		const dex = await ethers.deployContract("CrocSwapDex");
		// deploy ColdPath
		const ColdPath = await ethers.deployContract("ColdPath");
		// deploy HotPath
		const HotProxy = await ethers.deployContract("HotProxy");
		// deploy KnockoutPath
		const KnockoutLiqPath = await ethers.deployContract("KnockoutLiqPath");
		// deploy CrossKnockoutPath
		const KnockoutFlagPath = await ethers.deployContract(
			"KnockoutFlagPath"
		);
		// deploy LongPath
		const LongPath = await ethers.deployContract("LongPath");
		// deploy MicroPath
		const MicroPaths = await ethers.deployContract("MicroPaths");
		// deploy SafeModePath
		const SafeModePath = await ethers.deployContract("SafeModePath");
		// deploy WarmPath
		const WarmPath = await ethers.deployContract("WarmPath");
		// deploy LiquidityMiningPath
		const LiquidityMiningPath = await ethers.deployContract(
			"LiquidityMiningPath"
		);

		////////////////////////////////////////////////
		// install paths
		////////////////////////////////////////////////
		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, ColdPath.address, COLD_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, LongPath.address, LONG_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, WarmPath.address, LP_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, HotProxy.address, SWAP_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, MicroPaths.address, MICRO_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, KnockoutLiqPath.address, KNOCKOUT_LP_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, KnockoutFlagPath.address, FLAG_CROSS_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		cmd = abi.encode(
			["uint8", "address", "uint16"],
			[21, LiquidityMiningPath.address, LIQUIDITY_MINING_PROXY_IDX]
		);
		await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);

		////////////////////////////////////////////////
		// configure pools
		////////////////////////////////////////////////
		approveUSDC = await USDC.approve(
			dex.address,
			BigNumber.from(10).pow(36)
		);
		await approveUSDC.wait();
		approveCNOTE = await cNOTE.approve(
			dex.address,
			BigNumber.from(10).pow(36)
		);
		await approveCNOTE.wait();

		/* 
        /	2. set new pool liquidity (amount to lock up for new pool)
        /	   params = [code, liq]
        */
		let setPoolLiqCmd = abi.encode(["uint8", "uint128"], [112, 1]);
		tx = await dex.protocolCmd(3, setPoolLiqCmd, true);
		await tx.wait();

		/*
        /  3. Create new pool template
        /     params = [code, poolIDX, feeRate, tickSize, jitThresh, knockout, oracle]
        */
		let templateCmd = abi.encode(
			["uint8", "uint256", "uint16", "uint16", "uint8", "uint8", "uint8"],
			[110, 36000, 500, 1, 2, 64, 0]
		);
		tx = await dex.protocolCmd(3, templateCmd, false);
		await tx.wait();

		/*
        /  4. Initialize the new pool with USDC and cNOTE
        /     params = [code, token0, token1, poolIDX, sqrtPrice]
        */
		let initPoolCmd = abi.encode(
			["uint8", "address", "address", "uint256", "uint128"],
			[
				71,
				cNOTE.address,
				USDC.address,
				36000,
				toSqrtPrice(Math.pow(10, 12)),
			]
		);
		tx = await dex.userCmd(3, initPoolCmd, { gasLimit: 6000000 });
		await tx.wait();

		//////////////////////////////////////////////////
		// add liquidity to concentrated pool
		//////////////////////////////////////////////////
		const currentTick = 276324;
		const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

		// Mint concentrated liquidity
		let mintConcentratedLiqCmd = abi.encode(
			[
				"uint8",
				"address",
				"address",
				"uint256",
				"int24",
				"int24",
				"uint128",
				"uint128",
				"uint128",
				"uint8",
				"address",
			],
			[
				11, // code (mint concentrated liquidity in base token liq)
				cNOTE.address, // base token
				USDC.address, // quote token
				36000, // poolIDX
				currentTick - 15, // tickLower
				currentTick + 15, // tickUpper
				BigNumber.from("100000000000000000000"), // amount of base token to send
				BigNumber.from("16602069666338596454400000"), // min price
				BigNumber.from("20291418481080506777600000"), // max price
				0, // reserve flag
				ZERO_ADDR, // lp conduit address (0 if not using)
			]
		);
		tx = await dex.userCmd(2, mintConcentratedLiqCmd, {
			gasLimit: 6000000,
			value: ethers.utils.parseUnits("10", "ether"),
		});
		await tx.wait();

		////////////////////////////////////////////////
		// swap test
		////////////////////////////////////////////////
		swapTx = await dex.swap(
			cNOTE.address,
			USDC.address,
			36000,
			false,
			false,
			BigNumber.from("20000000"),
			0,
			BigNumber.from("16602069666338596454400000"),
			BigNumber.from("19000000000000000000"),
			0
		);

		await swapTx.wait();
		expect(await USDC.balanceOf(owner.address)).to.equal(
			BigNumber.from("999880351768")
		);

		//////////////////////////////////////////////////
		// set concentrated rewards
		//////////////////////////////////////////////////
		const blockNumBefore = await ethers.provider.getBlockNumber();
		const blockBefore = await ethers.provider.getBlock(blockNumBefore);
		const timestampBefore = blockBefore.timestamp;
		// console.log("timestamp before: ", timestampBefore);

		let poolHash = abi.encode(
			["address", "address", "uint256"],
			[cNOTE.address, USDC.address, 36000]
		);
		let setRewards = abi.encode(
			["uint8", "bytes32", "uint32", "uint32", "uint64"],
			[
				117,
				ethers.utils.keccak256(poolHash),
				Math.floor(timestampBefore / 10) * 10,
				Math.floor(timestampBefore / 10) * 10 + 1000,
				10,
			]
		);
		tx = await dex.protocolCmd(8, setRewards, true);
		await tx.wait();

		await time.increase(1000); // mine 1000 seconds

		//////////////////////////////////////////////////
		// claim rewards
		//////////////////////////////////////////////////
		// get eth balanace before claim
		const ethBalBefore = await ethers.provider.getBalance(dex.address);
		console.log("eth balance before claim: ", ethBalBefore.toString());
		let claim = abi.encode(
			["uint8", "bytes32", "int24", "int24", "uint32[]"],
			[
				101,
				keccak256(poolHash),
				currentTick - 15,
				currentTick + 15,
				[
					Math.floor(timestampBefore / 10) * 10,
					Math.floor(timestampBefore / 10) * 10 + 100,
				],
			]
		);
		tx = await dex.userCmd(8, claim);
		await tx.wait();
		// get eth balanace after claim
		const ethBalAfter = await ethers.provider.getBalance(dex.address);
		console.log("eth balance after claim: ", ethBalAfter.toString());
	});
});