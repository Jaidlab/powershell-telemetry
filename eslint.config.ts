import {makeEslintConfig} from 'eslint-config-jaid'
import {globalIgnores} from 'eslint/config'

const config: ReturnType<typeof makeEslintConfig> = [
  globalIgnores(['private/**']),
  ...makeEslintConfig(),
]

export default config
