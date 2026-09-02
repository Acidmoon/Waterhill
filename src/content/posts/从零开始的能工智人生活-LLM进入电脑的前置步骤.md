---
title: "2-将LLM请进电脑"
published: 2026-09-02
description: "将大语言模型放进电脑中干活，我们要干什么？"
tags: ["从零开始的能工智人生活"]
category: "教程"
draft: false
language: "zh_CN"
---

# 从零开始的能工智人生活-LLM接入电脑

> **前言**
本系列文章面向计算机与AI相关零基础的朋友，目的是让读者阅读实践后可以更好地驾驭电脑与如今的AI，受本人精力与能力限制，文章内容难免出现纰漏与不足，望读者在阅读时合理使用网络搜索工具进行深入了解。
> **适用对象**：刚高中毕业、没有系统接触过计算机的准大一新生
> **需要什么**：一台 Windows 电脑（本教程以 Windows 11 为例）、读完[上一章](/posts/从零开始的能工智人生活-终端/)、一个能登录 DeepSeek 开放平台（platform.deepseek.com，不是网页版聊天的 DeepSeek）的账号

---

## 第一部分：选择模型与工具

首先解释几个名词：

1. **`Agent`** Agent翻译过来就是智能体，相当于一个在你的电脑上驻留的数字员工，你就是老板。也可以理解为一台完整的小汽车。`Agent = Model + Harness`，model是发动机，Harness是除了发动机的大部分，Agent就是整台车了。

2. **`Harness`** Harness翻译过来就是鞍具，马鞍。就像是我们开的小汽车的方向盘、离合器、刹车油门、驾驶位、车窗等一系列的总和。

3. **`Token`** 通俗解释，这就是发动机烧的油，模型在处理文本的时候就是以token计算的，这个东西就是我们在使用模型时唯一需要付费的东西，一般计价单位是每百万tokens。用现在主流媒体话语，这玩意叫做`词元`，但我并不喜欢将这些词语用汉语表示，你写数学题的时候会把过程中的`2*x+y=z`写成`二乘以x加y等于z`吗？

:::note
由于时间精力的缘故，之后的名词本人不会一一写出解释，因为每一位读者的基础不同，不了解的方面也不同，无法面面俱到。故后文的没有给出解释的名词，若读者不清楚含义，请打开搜索引擎或者自己手机上的AI助手进行询问，相信它们会给出比我解释更好的答案
:::

那么我们现在要选择的就是选择一个**强劲又省油**（省token）的发动机，再找一个舒服的座驾。

要将我们的电脑交给别人来操作，我们必须保证对方能力不错，不会经常乱搞把电脑搞坏掉（说的就是Minimax，**强烈不推荐**使用Minimax M3作为Agent模型），同时又要兼顾API价格的低廉以及配置的难易程度，因此本人权衡之后，选择了`deepseek-v4-flash-vision-exp`作为演示模型。

那么如何选择我们的座驾呢？市面上已有的各种Harness多如牛毛（夸张手法），比如我们可能听说过的`Codex`、`Claude Code`、`Antigravity`这些海外公司推出的，以及如`WorkBuddy`、`Qoder`、`Zcode`等国内公司推出的产品。

在本文写作的时间点，我会选择让新手使用`Pi`这个极简的Harness，虽然它只有最基本的四个工具，没有像Claude Code一样完整的、开箱即用的配置。这个原因我会单独写一篇文章进行说明。

那么选型结束，我们要开始进行接入了

## 第二部分：开始接入

### 2.1 API准备

首先呢，我们要进行DeepSeek API的开通。

:::note
DeepSeek 的 API 是按量计费的，费用从账户余额里扣除。如果余额为零，最后一步开始对话时会收到「Insufficient Balance（余额不足）」的红色报错——到时候在开放平台左侧的「充值」页面充值即可解决，不用慌。
:::

我们首先在浏览器搜索`DeepSeek开放平台`或者直接点击[platform.deepseek.com](https://platform.deepseek.com)后登录进入页面：

![浏览器搜索DeepSeek开放平台.png](/images/deepseek-platform-search.png)

![DeepSeek开放平台登录后的用量信息页.png](/images/deepseek-platform.png)

之后点击`API Keys`进入API Key管理界面：

![DeepSeek平台的API Keys管理界面.png](/images/deepseek-platform-apikeys.png)

点击右上角的`创建API Key`：

![创建API Key弹窗.png](/images/deepseek-platform-create-apikey.png)

为它取一个名字，我们这里就叫做`tmp`了：

![复制新建的API Key.png](/images/deepseek-platform-create-apikey-copy.png)

:::caution
**一定不要将你的API Key暴露在公网中，API key是你访问API的唯一凭据！**
:::

### 2.2 Harness准备

我们使用`Pi`这一极简框架，我们可以访问Pi的官方来查看如何安装：[pi.dev](https://pi.dev/)

![Pi官网首页.png](/images/pi-homepage.png)

我们复制安装命令

```powershell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

到终端来进行安装：

![在终端粘贴安装命令.png](/images/install-pi.png)

点击回车开始安装：

![Pi安装器询问是否安装.png](/images/install-pi-1.png)

（如果你的电脑之前没装过 Node.js，这一步安装器会先多问一句「是否安装 Node.js」，直接回车采用默认的 Y 等它装完，之后看到的就是和截图一样的画面。）

输入y来进行安装：

![Pi开始安装.png](/images/install-pi-2.png)

等待安装完成。安装完成之后应该是这样的界面：

![Pi安装完成.png](/images/install-pi-3.png)

然后我们启动pi，在终端直接输入`pi`即可启动。

刚开始的pi应该是这样：

![Pi首次启动.png](/images/pi-init-1.png)

不必担心，我们输入`/login`开始配置我们的DeepSeek模型：

![输入/login命令.png](/images/pi-init-2.png)

![选择认证方式.png](/images/pi-init-3.png)

我们选择通过API接入（即图中的`Sign in with an API key`），用方向键的上下键来操作，回车进行选择：

![选择要配置的提供商.png](/images/pi-init-4.png)

我们用↓键找到`DeepSeek`：

![找到DeepSeek.png](/images/pi-init-5.png)

点击enter来进行API Key的配置：

![粘贴API Key.png](/images/pi-init-6.png)

在这里粘贴我们刚刚复制保存的API Key然后回车：

![API Key保存成功.png](/images/pi-init-7.png)

然后我们进行模型的配置以及思考等级的配置。思考等级我建议大家使用`max`等级。

输入`/model`进行模型切换（注意：刚配好 Key 时 Pi 默认选中的是更贵的 `deepseek-v4-pro`，我们要换成下面更省油的型号）：

![输入/model命令.png](/images/pi-init-8.png)

![模型选择列表.png](/images/pi-init-9.png)

选择`vision-exp`这个模型，然后输入`/thinking`来调节思考等级：

![思考等级选择菜单.png](/images/pi-init-10.png)

选择`max`：

![思考等级设置完成.png](/images/pi-init-11.png)

开始进行对话：

![向Pi发送提问.png](/images/pi-init-12.png)

![Pi的自我介绍回复.png](/images/pi-init-13.png)

进行到这里我们就算是完全配置完毕了！我们已经将一个前沿的大语言模型请进了我们的电脑中，通过Pi Coding Agent，DeepSeek的这个视觉模型可以访问我们的电脑上的文件。**此时我们就不再只是局限于和模型在网页或者应用内聊天对话了！**

> **延伸阅读**：[DeepSeek 开放平台](https://platform.deepseek.com)、[Pi 官网](https://pi.dev/)

:::note
`本文使用 GLM-5.3-flash辅助润色`
:::
