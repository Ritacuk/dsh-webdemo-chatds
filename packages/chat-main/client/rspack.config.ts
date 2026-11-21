import { defineConfig } from '@rspack/cli'
import { rspack } from '@rspack/core'

// 未显式要求 development 时一律按生产构建(Windows shell 不便注入 NODE_ENV)。
const isProd = process.env.NODE_ENV !== 'development'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']

// 构建配置与官方 demo 的 rspack.config.ts 对齐(createConfig 同款语义),差异仅:
// - 无 __API_ORIGIN__ 注入(页面只与 Host 插件路由通信);
// - 产物输出到 ../client-dist(Host 路由服务),publicPath 'auto' 由 <base href> 解析;
// - css modules 保留 demo 的默认导出风格与 localIdentName。
export default defineConfig({
  mode: isProd ? 'production' : 'development',
  entry: './src/main.tsx',
  output: {
    path: '../client-dist',
    publicPath: 'auto',
    filename: 'assets/[name]-[contenthash:8].js',
    chunkFilename: 'assets/async/[name]-[contenthash:8].js',
    cssFilename: 'assets/[name]-[contenthash:8].css',
    cssChunkFilename: 'assets/async/[name]-[contenthash:8].css',
    assetModuleFilename: 'assets/media/[name]-[contenthash:8][ext]',
    clean: true,
  },
  devtool: isProd ? false : 'cheap-module-source-map',
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // TS 以 ESM 风格书写 `.js` 导入(specifier 指向 .ts/.tsx 源),需要 extensionAlias。
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出:import styles from './x.module.css'(demo 同款)
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      {
        test: /\.module\.css$/,
        type: 'css/module',
        use: [{ loader: 'builtin:lightningcss-loader', options: { targets } }],
      },
      {
        test: /\.css$/,
        exclude: /\.module\.css$/,
        type: 'css',
        use: [{ loader: 'builtin:lightningcss-loader', options: { targets } }],
      },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: !isProd } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    new rspack.CopyRspackPlugin({ patterns: [{ from: 'public/webchat-icon.svg', to: 'assets/webchat-icon.svg' }] }),
    // 经典 defer 脚本;页面由插件路由 /chat-workspace 提供,注入 <base href> 后相对路径可用。
    new rspack.HtmlRspackPlugin({
      template: './index.html',
      scriptLoading: 'defer',
    }),
  ],
  performance: { hints: false },
  devServer: { port: 5199 },
})
