type LineKind = 'instruction' | 'data' | 'other';
const dataDirectives = new Set('db dw dd dq dt do dy dz resb resw resd resq rest reso resy resz'.split(' '));
const prefixes = new Set(
  'lock rep repe repz repne repnz bnd xacquire xrelease a16 a32 o16 o32 cs ds es fs gs ss notrack'.split(' ')
);
// Deliberately explicit: unrecognised pseudo-instructions must not become executable lines.
const instructions = new Set(
  (
    'aaa aad aam aas adc add and arpl bound bsf bsr bswap bt btc btr bts call cbw cdq clc cld cli clts cmc cmp cmps cmpsb cmpsw cmpsd ' +
    'cmpxchg cmpxchg8b cpuid cwd cwde daa das dec div enter hlt idiv imul in inc ins insb insw insd int int1 int3 into invd invlpg ' +
    'iret iretd ja jae jb jbe jc jcxz jecxz je jg jge jl jle jmp jna jnae jnb jnbe jnc jne jng jnge jnl jnle jno jnp jns jnz jo jp jpe jpo js jz ' +
    'lahf lar lds lea leave les lfs lgdt lgs lidt lldt lmsw lods lodsb lodsw lodsd loop loope loopne loopnz loopz lsl lss ltr ' +
    'mov movs movsb movsw movsd movsx movzx mul neg nop not or out outs outsb outsw outsd pop popa popad popf popfd ' +
    'push pusha pushad pushf pushfd rcl rcr rdmsr rdpmc rdtsc ret retn retf rol ror rsm sahf sal sar sbb scas scasb scasw scasd ' +
    'seta setae setb setbe setc sete setg setge setl setle setna setnae setnb setnbe setnc setne setng setnge setnl setnle setno setnp setns setnz seto setp setpe setpo sets setz ' +
    'sgdt shl shld shr shrd sidt sldt smsw stc std sti stos stosb stosw stosd str sub test ud2 verr verw wait fwait wbinvd wrmsr xadd xchg xlat xlatb xor ' +
    'f2xm1 fabs fadd faddp fbld fbstp fchs fclex fcmovb fcmovbe fcmove fcmovnb fcmovnbe fcmovne fcmovnu fcmovu fcom fcomp fcompp ' +
    'fcos fdecstp fdiv fdivp fdivr fdivrp ffree fiadd ficom ficomp fidiv fidivr fild fimul fincstp finit fist fistp fisub fisubr ' +
    'fld fld1 fldcw fldenv fldl2e fldl2t fldlg2 fldln2 fldpi fldz fmul fmulp fnclex fninit fnop fnsave fnstcw fnstenv fnstsw ' +
    'fpatan fprem fprem1 fptan frndint frstor fsave fscale fsin fsincos fsqrt fst fstcw fstenv fstp fstsw fsub fsubp fsubr fsubrp ' +
    'ftst fucom fucomp fucompp fxam fxch fxtract fyl2x fyl2xp1'
  ).split(' ')
);
const identifier = '[A-Za-z_.$?@][A-Za-z0-9_.$?@]*';
const label = new RegExp(`^${identifier}\\s*:\\s*`);
const bareLabel = new RegExp(`^(${identifier})\\s+(.+)$`);

export function fail(message: string, line?: number): never {
  throw new Error(`无法建立调试源码映射${line === undefined ? '' : `（第 ${line} 行）`}：${message}`);
}

/** Preserve quoted semicolons, but remove comments before inspecting directives. */
function codeWithoutComment(text: string, line: number): string {
  let quote = '';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      result += char;
      if (quote === '`' && char === '\\' && i + 1 < text.length) result += text[++i];
      else if (char === quote) quote = '';
    } else if (char === ';') break;
    else {
      if (char === '"' || char === "'" || char === '`') quote = char;
      if (char === '%') fail('首版调试不支持预处理器、include 或宏。请使用单文件源码', line);
      if (char === '\\') fail('首版调试不支持跨行语句', line);
      result += char;
    }
  }
  if (quote) fail('首版调试要求字符串在同一行闭合', line);
  return result.trim();
}

function constant(text: string, line: number): number {
  const value = text.replace(/_/g, '');
  let number: number;
  if (/^0x[0-9a-f]+$/i.test(value)) number = Number.parseInt(value.slice(2), 16);
  else if (/^0b[01]+$/i.test(value)) number = Number.parseInt(value.slice(2), 2);
  else if (/^0o[0-7]+$/i.test(value)) number = Number.parseInt(value.slice(2), 8);
  else if (/^[0-9][0-9a-f]*h$/i.test(value)) number = Number.parseInt(value.slice(0, -1), 16);
  else if (/^\d+$/.test(value)) number = Number(value);
  else fail('BITS / ORG 必须使用数字常量，不能使用符号或表达式', line);
  if (!Number.isSafeInteger(number)) fail('数字常量超出安全范围', line);
  return number;
}

function statement(text: string): string {
  while (label.test(text)) text = text.replace(label, '');
  // NASM permits "message db ..." and "start mov ..." without a colon.
  const match = bareLabel.exec(text);
  if (
    match &&
    !instructions.has(match[1].toLowerCase()) &&
    !prefixes.has(match[1].toLowerCase()) &&
    !dataDirectives.has(match[1].toLowerCase()) &&
    !/^(bits|org|times|align|alignb)$/i.test(match[1])
  ) {
    const next = match[2].split(/\s/, 1)[0].toLowerCase();
    if (dataDirectives.has(next) || instructions.has(next) || prefixes.has(next) || next === 'equ')
      text = match[2];
  }
  return text;
}

export function inspectSource(
  lines: string[],
  loadAddress: number,
  initialBits: 16 | 32 | 'auto'
): { kinds: LineKind[]; origin: number; modes: (16 | 32)[] } {
  let origin: number | undefined;
  let hasBits = false;
  let bits: 16 | 32 | undefined = initialBits === 'auto' ? undefined : initialBits;
  const modes: (16 | 32)[] = [];
  const kinds = lines.map((text, index): LineKind => {
    // Lines before the first BITS may contain only directives, labels or data.
    modes.push(bits ?? 16);
    const line = index + 1;
    let code = codeWithoutComment(text, line);
    if (!code) return 'other';
    if (code.startsWith('[')) {
      if (!code.endsWith(']')) fail('无法识别 NASM 方括号指令', line);
      code = code.slice(1, -1).trim();
    }
    const directive = /^(bits|org)\s+(.+)$/i.exec(code);
    if (directive) {
      const value = constant(directive[2].trim(), line);
      if (directive[1].toLowerCase() === 'bits') {
        if (value !== 16 && value !== 32) fail('调试只支持 BITS 16 和 BITS 32，不支持 64 位代码', line);
        if (!hasBits && initialBits !== 'auto' && value !== initialBits)
          fail(`调试要求先显式声明 BITS ${initialBits}，再切换代码模式`, line);
        bits = value;
        hasBits = true;
      } else {
        if (origin !== undefined || value !== loadAddress) {
          fail(`调试要求唯一的 ORG 0x${loadAddress.toString(16)}，与配置的加载地址一致`, line);
        }
        origin = value;
      }
      return 'other';
    }
    code = statement(code);
    if (!code) return 'other';
    let mnemonic = code.split(/\s/, 1)[0].toLowerCase();
    if (mnemonic === 'times') {
      const repeated =
        /^times\s+(.+?)\s+(db|dw|dd|dq|dt|do|dy|dz|resb|resw|resd|resq|rest|reso|resy|resz)\b/i.exec(code);
      if (!repeated || !/^[\dA-Fa-f_xXhHbBoOqQdD$()\s+*/<>&|^~!-]+$/.test(repeated[1])) {
        fail('TIMES 只支持数字或 $ / $$ 表达式的数据填充；重复指令不能设置可靠断点', line);
      }
      return 'data';
    }
    if (dataDirectives.has(mnemonic) || mnemonic === 'align' || mnemonic === 'alignb') return 'data';
    if (mnemonic === 'equ') return 'other';
    while (prefixes.has(mnemonic)) {
      code = code.slice(mnemonic.length).trim();
      mnemonic = code.split(/\s/, 1)[0].toLowerCase();
      if (!mnemonic) fail('指令前缀必须与指令写在同一行', line);
    }
    if (instructions.has(mnemonic)) {
      if (bits === undefined)
        fail('自动识别代码模式要求在首条可执行指令之前显式声明 BITS 16 或 BITS 32', line);
      return 'instruction';
    }
    fail(`调试不支持语句“${mnemonic}”；每个加载阶段须独立编译，不使用 section、incbin、include 或宏`, line);
  });
  if (!hasBits || origin === undefined)
    fail(
      `调试要求显式 ${initialBits === 'auto' ? 'BITS 16 或 BITS 32' : `BITS ${initialBits}`} 和 ORG 0x${loadAddress.toString(16)}`
    );
  return { kinds, origin, modes };
}
