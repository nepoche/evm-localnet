// This a simple script to start two local testnet chains and deploy the contracts on both of them
require('dotenv').config();
import readline from 'readline';
import { ethers } from 'ethers';
import { SignatureBridge } from '@webb-tools/bridges';
import { MintableToken } from '@webb-tools/tokens';
import { fetchComponentsFromFilePaths, getChainIdType } from '@webb-tools/utils';
import path from 'path';
import { IAnchorDeposit } from '@webb-tools/interfaces';
import { Anchor } from '@webb-tools/anchors';
import ganache from 'ganache';

export type GanacheAccounts = {
  balance: string;
  secretKey: string;
};

export async function startGanacheServer(
  port: number,
  networkId: number,
  populatedAccounts: GanacheAccounts[],
  options: any = {}
) {
  const ganacheServer = ganache.server({
    accounts: populatedAccounts,
    // quiet: true,
    network_id: networkId,
    chainId: networkId,
    miner: {
      blockTime: 1,
    },
    ...options,
  });

  await ganacheServer.listen(port);
  console.log(`Ganache Started on http://127.0.0.1:${port} ..`);

  return ganacheServer;
}

// Let's first define a localchain
class LocalChain {
  public readonly endpoint: string;
  private readonly server: any;
  public readonly chainId: number;
  constructor(
    public readonly name: string,
    public readonly evmId: number,
    readonly initalBalances: GanacheAccounts[]
  ) {
    this.endpoint = `http://localhost:${evmId}`;
    this.chainId = getChainIdType(evmId);
    this.server = startGanacheServer(evmId, evmId, initalBalances);
  }

  public provider(): ethers.providers.WebSocketProvider {
    return new ethers.providers.WebSocketProvider(this.endpoint);
  }

  public async stop() {
    this.server.close();
  }

  public async deployToken(
    name: string,
    symbol: string,
    wallet: ethers.Signer
  ): Promise<MintableToken> {
    return MintableToken.createToken(name, symbol, wallet);
  }

  public async deploySignatureBridge(
    otherChain: LocalChain,
    localToken: MintableToken,
    otherToken: MintableToken,
    localWallet: ethers.Wallet,
    otherWallet: ethers.Wallet
  ): Promise<SignatureBridge> {
    localWallet.connect(this.provider());
    otherWallet.connect(otherChain.provider());
    const bridgeInput = {
      anchorInputs: {
        asset: {
          [this.chainId]: [localToken.contract.address],
          [otherChain.chainId]: [otherToken.contract.address],
        },
        anchorSizes: [ethers.utils.parseEther('1')],
      },
      chainIDs: [this.chainId, otherChain.chainId],
    };
    const deployerConfig = {
      [this.chainId]: localWallet,
      [otherChain.chainId]: otherWallet,
    };
    const governorConfig = {
      [this.chainId]: localWallet,
      [otherChain.chainId]: otherWallet,
    }
    const zkComponents = await fetchComponentsFromFilePaths(
      path.resolve(
        __dirname,
        './protocol-solidity-fixtures/fixtures/anchor/2/poseidon_anchor_2.wasm'
      ),
      path.resolve(
        __dirname,
        './protocol-solidity-fixtures/fixtures/anchor/2/witness_calculator.js'
      ),
      path.resolve(
        __dirname,
        './protocol-solidity-fixtures/fixtures/anchor/2/circuit_final.zkey'
      )
    );

    return SignatureBridge.deployFixedDepositBridge(
      bridgeInput,
      deployerConfig,
      governorConfig,
      zkComponents
    );
  }
}

async function main() {
  const relayerPrivateKey =
    '0x0000000000000000000000000000000000000000000000000000000000000001';
  const senderPrivateKey =
    '0x0000000000000000000000000000000000000000000000000000000000000002';
  const recipient = '0xd644f5331a6F26A7943CEEbB772e505cDDd21700';

  const chainA = new LocalChain('Hermes', 5001, [
    {
      balance: ethers.utils.parseEther('1000').toHexString(),
      secretKey: relayerPrivateKey,
    },
    {
      balance: ethers.utils.parseEther('1000').toHexString(),
      secretKey: senderPrivateKey,
    },
    {
      balance: ethers.utils.parseEther('1000').toHexString(),
      secretKey: '0xc0d375903fd6f6ad3edafc2c5428900c0757ce1da10e5dd864fe387b32b91d7e',
    },
  ]);
  const chainB = new LocalChain('Athena', 5002, [
    {
      balance: ethers.utils.parseEther('1000').toHexString(),
      secretKey: relayerPrivateKey,
    },
    {
      balance: ethers.utils.parseEther('1000').toHexString(),
      secretKey: senderPrivateKey,
    },
    {
      balance: ethers.utils.parseEther('1000').toHexString(),
      secretKey: '0xc0d375903fd6f6ad3edafc2c5428900c0757ce1da10e5dd864fe387b32b91d7e',
    },
  ]);
  const chainAWallet = new ethers.Wallet(relayerPrivateKey, chainA.provider());
  const chainBWallet = new ethers.Wallet(relayerPrivateKey, chainB.provider());

  let chainADeposits: IAnchorDeposit[] = [];
  let chainBDeposits: IAnchorDeposit[] = [];

  // do a random transfer on chainA to a random address
  // se we do have different nonce for that account.
  let tx = await chainAWallet.sendTransaction({
    to: '0x0000000000000000000000000000000000000000',
    value: ethers.utils.parseEther('0.001'),
  });
  await tx.wait();
  // Deploy the token on chainA
  const chainAToken = await chainA.deployToken('ChainA', 'webbA', chainAWallet);
  // Deploy the token on chainB
  const chainBToken = await chainB.deployToken('ChainB', 'webbB', chainBWallet);

  // Deploy the signature bridge.
  const signatureBridge = await chainA.deploySignatureBridge(
    chainB,
    chainAToken,
    chainBToken,
    chainAWallet,
    chainBWallet
  );
  // get chainA bridge
  const chainASignatureBridge = signatureBridge.getBridgeSide(chainA.chainId)!;
  // get chainB bridge
  const chainBSignatureBridge = signatureBridge.getBridgeSide(chainB.chainId)!;
  // get the anchor on chainA
  const chainASignatureAnchor = signatureBridge.getAnchor(
    chainA.chainId,
    ethers.utils.parseEther('1')
  )!;
  await chainASignatureAnchor.setSigner(chainAWallet);

  const chainAHandler = await chainASignatureAnchor.getHandler();
  console.log('Chain A Handler address: ', chainAHandler)

  // get the anchor on chainB
  const chainBSignatureAnchor = signatureBridge.getAnchor(
    chainB.chainId,
    ethers.utils.parseEther('1')
  )!;
  await chainBSignatureAnchor.setSigner(chainBWallet);

  const chainBHandler = await chainBSignatureAnchor.getHandler();
  console.log('Chain B Handler address: ', chainBHandler)
  
  // approve token spending
  const webbASignatureTokenAddress = signatureBridge.getWebbTokenAddress(
    chainA.chainId
  )!;

  const webbASignatureToken = await MintableToken.tokenFromAddress(
    webbASignatureTokenAddress,
    chainAWallet
  );
  tx = await webbASignatureToken.approveSpending(
    chainASignatureAnchor.contract.address
  );
  await tx.wait();
  await webbASignatureToken.mintTokens(
    chainAWallet.address,
    ethers.utils.parseEther('1000')
  );

  const webbBSignatureTokenAddress = signatureBridge.getWebbTokenAddress(chainB.chainId)!;
  console.log('webbBTokenAddress: ', webbBSignatureTokenAddress);

  const webbBSignatureToken = await MintableToken.tokenFromAddress(
    webbBSignatureTokenAddress,
    chainBWallet
  );
  tx = await webbBSignatureToken.approveSpending(chainBSignatureAnchor.contract.address);
  await tx.wait();
  await webbBSignatureToken.mintTokens(
    chainBWallet.address,
    ethers.utils.parseEther('1000')
  );

  console.log(
    'ChainA signature bridge (Hermes): ',
    chainASignatureBridge.contract.address
  );
  console.log(
    'ChainA anchor (Hermes): ',
    chainASignatureAnchor.contract.address
  );
  console.log('ChainAToken: ', chainAToken.contract.address);
  console.log('ChainA Webb token (Hermes): ', webbASignatureToken.contract.address);
  console.log(' --- --- --- --- --- --- --- --- --- --- --- --- ---');
  console.log(
    'ChainB signature bridge (Athena): ',
    chainBSignatureBridge.contract.address
  );
  console.log(
    'ChainB anchor (Athena): ',
    chainBSignatureAnchor.contract.address
  );
  console.log('ChainBToken: ', chainBToken.contract.address);
  console.log('ChainB token Webb (Athena): ', webbBSignatureToken.contract.address);
  console.log('\n');
  // stop the server on Ctrl+C or SIGINT singal
  process.on('SIGINT', () => {
    chainA.stop();
    chainB.stop();
  });
  printAvailableCommands();

  await webbASignatureToken.mintTokens(
    '0x510C6297cC30A058F41eb4AF1BFC9953EaD8b577',
    ethers.utils.parseEther('1000')
  );

  await webbBSignatureToken.mintTokens(
    '0x7758F98C1c487E5653795470eEab6C4698bE541b',
    ethers.utils.parseEther('1000')
  );

  // setup readline
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', async (cmdRaw) => {
    const cmd = cmdRaw.trim();
    if (cmd === 'exit') {
      // shutdown the servers
      await chainA.stop();
      await chainB.stop();
      rl.close();
      return;
    }
    // check if cmd is deposit chainA
    if (cmd.startsWith('deposit on chain a')) {
      console.log('Depositing Chain A, please wait...');
      const deposit2 = await chainASignatureAnchor.deposit(chainB.chainId);
      chainADeposits.push(deposit2);
      console.log('Deposit on chain A (signature): ', deposit2);
      // await signatureBridge.updateLinkedAnchors(chainASignatureAnchor);
      return;
    }

    if (cmd.startsWith('deposit on chain b')) {
      console.log('Depositing Chain B, please wait...');
      const deposit2 = await chainBSignatureAnchor.deposit(chainA.chainId);
      chainBDeposits.push(deposit2);
      console.log('Deposit on chain B (signature): ', deposit2);
      // await signatureBridge.updateLinkedAnchors(chainASignatureAnchor);
      return;
    }

    if (cmd.startsWith('relay from a to b')) {
      await (chainASignatureAnchor as unknown as Anchor).update(chainASignatureAnchor.latestSyncedBlock);
      await signatureBridge.updateLinkedAnchors(chainASignatureAnchor);
    }

    if (cmd.startsWith('relay from b to a')) {
      await (chainBSignatureAnchor as unknown as Anchor).update(chainBSignatureAnchor.latestSyncedBlock);
      await signatureBridge.updateLinkedAnchors(chainBSignatureAnchor);
    }

    if (cmd.startsWith('withdraw on chain a')) {
      const result = await signatureBridge.withdraw(
        chainBDeposits.pop()!,
        ethers.utils.parseEther('1'),
        recipient,
        chainAWallet.address,
        chainAWallet
      );
      result ? console.log('withdraw success') : console.log('withdraw failure');
      return;
    }

    if (cmd.startsWith('withdraw on chain b')) {
      let result: boolean = false;
      // take a deposit from the chain A
      try {
        result = await signatureBridge.withdraw(
          chainADeposits.pop()!,
          ethers.utils.parseEther('1'),
          recipient,
          chainBWallet.address,
          chainBWallet
        );
      } catch (e) {
        console.log('ERROR: ', e);
      }
      result ? console.log('withdraw success') : console.log('withdraw failure');
      return;
    }

    if (cmd.match(/^spam chain a (\d+)$/)) {
      const txs = parseInt(cmd.match(/^spam chain a (\d+)$/)?.[1] ?? '1');
      console.log(`Spamming Chain A with ${txs} Tx, please wait...`);
      for (let i = 0; i < txs; i++) {
        const deposit2 = await chainASignatureAnchor.deposit(chainB.chainId);
        console.log('Deposit on chain A (signature): ', deposit2.deposit);
      }
      return;
    }

    if (cmd.match(/^spam chain b (\d+)$/)) {
      const txs = parseInt(cmd.match(/^spam chain b (\d+)$/)?.[1] ?? '1');
      console.log(`Spamming Chain B with ${txs}, please wait...`);
      for (let i = 0; i < txs; i++) {
        const deposit2 = await chainBSignatureAnchor.deposit(chainA.chainId);
        console.log('Deposit on chain B (signature): ', deposit2.deposit);
      }
      return;
    }

    if (cmd.startsWith('root on chain a')) {
      console.log('Root on chain A (signature), please wait...');
      const root2 = await chainASignatureAnchor.contract.getLastRoot();
      const latestNeighborRoots2 =
        await chainASignatureAnchor.contract.getLatestNeighborRoots();
      console.log('Root on chain A (signature): ', root2);
      console.log(
        'Latest neighbor roots on chain A (signature): ',
        latestNeighborRoots2
      );
      return;
    }

    if (cmd.startsWith('root on chain b')) {
      console.log('Root on chain B (signature), please wait...');
      const root2 = await chainBSignatureAnchor.contract.getLastRoot();
      const latestNeighborRoots2 =
        await chainBSignatureAnchor.contract.getLatestNeighborRoots();
      console.log('Root on chain B (signature): ', root2);
      console.log(
        'Latest neighbor roots on chain B (signature): ',
        latestNeighborRoots2
      );
      return;
    }

    console.log('Unknown command: ', cmd);
    printAvailableCommands();
  });
}

function printAvailableCommands() {
  console.log('Available commands:');
  console.log('  deposit on chain a');
  console.log('  deposit on chain b');
  console.log('  relay from a to b');
  console.log('  relay from b to a');
  console.log('  withdraw on chain a');
  console.log('  withdraw on chain b');
  console.log('  root on chain a');
  console.log('  root on chain b');
  console.log('  spam chain a <txs>');
  console.log('  spam chain b <txs>');
  console.log('  transfer ownership to <pubkey>');
  console.log('  exit');
}

main().catch(console.error);
